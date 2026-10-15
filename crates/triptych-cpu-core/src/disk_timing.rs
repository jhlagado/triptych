//! Optional mechanical floppy timing for the record controller.
//!
//! The Triptych controller addresses a flat sequence of 128-byte records and
//! completes every command at once. This model lays those records over an
//! imaginary floppy drive and computes how long each command would take on
//! that drive: head load or motor spin-up, stepping, settle, rotational wait
//! and sector transfer. Time is measured in guest T-states, never host time,
//! so results are deterministic and independent of host speed.
//!
//! The geometry belongs to the timing profile, not to the disk image's DPB.
//! Record `r` occupies physical sector `r * 128 / sector_bytes`; physical
//! sectors fill a track, then the next head, then the next cylinder. Disk
//! images larger than the profiled medium simply continue onto imaginary
//! cylinders; `DiskTimingStats::max_cylinder` shows when that happened.

use crate::RECORD_BYTES;

const DRIVE_COUNT: usize = 16;

/// Mechanical parameters of one floppy drive and medium.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct DiskTimingProfile {
    pub name: &'static str,
    /// Spindle speed in revolutions per minute.
    pub rpm: u32,
    /// Physical sector size: 128, 256, 512 or 1024 bytes. Sizes above 128
    /// are deblocked through one host buffer, as a CP/M 2.2 BIOS does.
    pub sector_bytes: u16,
    pub sectors_per_track: u16,
    pub heads: u8,
    /// Cylinders on the real medium. Used only for reporting overflow.
    pub cylinders: u16,
    /// Logical-to-physical sector interleave within a track (1 = none).
    pub skew: u16,
    /// Time to step the head one cylinder.
    pub step_us: u32,
    /// Head settle time after the last step of a seek.
    pub settle_us: u32,
    /// Head load or motor spin-up time paid when the drive has been idle.
    pub ready_us: u32,
    /// Idle time after which the head unloads or the motor stops.
    pub idle_us: u32,
}

impl DiskTimingProfile {
    /// IBM 3740 8-inch single-sided single-density: the original CP/M 2.2
    /// distribution format, on a Shugart SA800-class drive.
    pub const EIGHT_INCH_SSSD: Self = Self {
        name: "8in-sssd",
        rpm: 360,
        sector_bytes: 128,
        sectors_per_track: 26,
        heads: 1,
        cylinders: 77,
        skew: 6,
        step_us: 8_000,
        settle_us: 8_000,
        ready_us: 35_000,
        idle_us: 2_500_000,
    };

    /// 5.25-inch double-sided double-density, 40 cylinders of 10 x 512-byte
    /// sectors per side (400 KiB), with a deblocking BIOS.
    pub const FIVE_INCH_DSDD: Self = Self {
        name: "5in-dsdd",
        rpm: 300,
        sector_bytes: 512,
        sectors_per_track: 10,
        heads: 2,
        cylinders: 40,
        skew: 2,
        step_us: 6_000,
        settle_us: 15_000,
        ready_us: 500_000,
        idle_us: 2_000_000,
    };

    /// 3.5-inch double-sided double-density, 80 cylinders of 9 x 512-byte
    /// sectors per side (720 KiB), with a deblocking BIOS.
    pub const THREE_INCH_DSDD: Self = Self {
        name: "3in-dsdd",
        rpm: 300,
        sector_bytes: 512,
        sectors_per_track: 9,
        heads: 2,
        cylinders: 80,
        skew: 1,
        step_us: 3_000,
        settle_us: 15_000,
        ready_us: 500_000,
        idle_us: 2_000_000,
    };

    pub const BUILT_IN: [Self; 3] = [
        Self::EIGHT_INCH_SSSD,
        Self::FIVE_INCH_DSDD,
        Self::THREE_INCH_DSDD,
    ];

    pub fn named(name: &str) -> Option<Self> {
        Self::BUILT_IN
            .into_iter()
            .find(|profile| profile.name == name)
    }

    /// Whether the geometry can be modelled. Rejects zero dimensions, sector
    /// sizes that are not a whole number of records, and a skew of zero.
    pub fn is_valid(&self) -> bool {
        self.rpm != 0
            && self.sector_bytes != 0
            && usize::from(self.sector_bytes) % RECORD_BYTES == 0
            && self.sectors_per_track != 0
            && self.heads != 0
            && self.skew != 0
    }

    pub fn capacity_bytes(&self) -> u64 {
        u64::from(self.sector_bytes)
            * u64::from(self.sectors_per_track)
            * u64::from(self.heads)
            * u64::from(self.cylinders)
    }

    fn records_per_sector(&self) -> u32 {
        u32::from(self.sector_bytes) / RECORD_BYTES as u32
    }

    /// Rotational slot of a logical sector within its track, using the
    /// conventional skew table: advance by `skew`, and step one slot on
    /// whenever the walk returns to an occupied slot.
    fn slot(&self, logical: u32) -> u32 {
        let sectors = u32::from(self.sectors_per_track);
        let skew = u32::from(self.skew) % sectors;
        let skew = if skew == 0 { 1 } else { skew };
        let cycle = sectors / gcd(sectors, skew);
        ((logical % cycle) * skew + logical / cycle) % sectors
    }
}

/// How the guest experiences the modelled delays.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DiskTimingMode {
    /// Commands still complete at once; delays are only added up. Guest
    /// behaviour is unchanged, and the model advances its own clock as though
    /// the guest had waited.
    Account,
    /// The controller reports BUSY until each modelled delay has elapsed in
    /// guest T-states, so a BIOS that polls BUSY really waits.
    Stall,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct DiskTimingConfig {
    pub profile: DiskTimingProfile,
    pub mode: DiskTimingMode,
    /// Guest CPU clock used to convert mechanical times to T-states.
    pub clock_hz: u32,
}

impl DiskTimingConfig {
    pub const DEFAULT_CLOCK_HZ: u32 = 4_000_000;

    pub fn new(profile: DiskTimingProfile, mode: DiskTimingMode) -> Self {
        Self {
            profile,
            mode,
            clock_hz: Self::DEFAULT_CLOCK_HZ,
        }
    }
}

/// Counters accumulated since timing was configured. All times are T-states.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct DiskTimingStats {
    /// Guest record commands seen by the model.
    pub record_reads: u64,
    pub record_writes: u64,
    /// Record reads satisfied by the deblocking buffer without disk access.
    pub buffer_hits: u64,
    /// Physical sector transfers, including deblocking pre-reads.
    pub sector_reads: u64,
    pub sector_writes: u64,
    pub seeks: u64,
    pub cylinders_stepped: u64,
    /// Head loads or motor spin-ups after idle.
    pub ready_waits: u64,
    pub ready_tstates: u64,
    pub seek_tstates: u64,
    pub rotation_tstates: u64,
    pub transfer_tstates: u64,
    /// Sum of all of the above: the time the guest spent, or would have
    /// spent, waiting on the disk.
    pub disk_tstates: u64,
    pub max_cylinder: u32,
}

/// A snapshot of the timing model for hosts to report.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct DiskTimingReport {
    pub config: DiskTimingConfig,
    pub stats: DiskTimingStats,
    /// Guest T-states actually executed since timing was configured.
    pub guest_tstates: u64,
    /// Modelled time since timing was configured: executed T-states plus,
    /// in account mode, the waits the guest skipped. Never less than the end
    /// of the latest modelled command.
    pub modelled_tstates: u64,
    /// Whether the deblocking buffer holds a write not yet sent to disk.
    pub write_pending: bool,
}

impl DiskTimingReport {
    pub fn tstates_to_micros(&self, tstates: u64) -> u64 {
        (u128::from(tstates) * 1_000_000 / u128::from(self.config.clock_hz)) as u64
    }
}

#[derive(Clone, Copy, Default)]
struct Head {
    cylinder: u32,
    active: bool,
    last_end: u64,
}

#[derive(Clone, Copy, Eq, PartialEq)]
struct Buffered {
    drive: u8,
    sector: u32,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum Access {
    Read,
    Write,
    Flush,
}

pub(crate) struct DiskTiming {
    config: DiskTimingConfig,
    stats: DiskTimingStats,
    heads: [Head; DRIVE_COUNT],
    buffered: Option<Buffered>,
    buffer_dirty: bool,
    /// Guest clock at configuration.
    origin: u64,
    /// Account mode: waits the guest skipped, added to the guest clock to
    /// give the modelled clock.
    skipped: u64,
    last_now: u64,
    /// Modelled clock at which the latest command completes.
    horizon: u64,
}

impl DiskTiming {
    pub(crate) fn new(config: DiskTimingConfig, now: u64) -> Self {
        Self {
            config,
            stats: DiskTimingStats::default(),
            heads: [Head::default(); DRIVE_COUNT],
            buffered: None,
            buffer_dirty: false,
            origin: now,
            skipped: 0,
            last_now: now,
            horizon: now,
        }
    }

    pub(crate) fn mode(&self) -> DiskTimingMode {
        self.config.mode
    }

    pub(crate) fn report(&self, now: u64) -> DiskTimingReport {
        let guest = now.max(self.last_now) - self.origin;
        // A guest that ignores BUSY can stop before a stalled command ends.
        let modelled = (guest + self.skipped).max(self.horizon - self.origin);
        DiskTimingReport {
            config: self.config,
            stats: self.stats,
            guest_tstates: guest,
            modelled_tstates: modelled,
            write_pending: self.buffer_dirty,
        }
    }

    /// Forget buffered data after a machine reset or media change. A dirty
    /// buffer is dropped: the controller has its own durable write path, and
    /// the model only accounts for time.
    pub(crate) fn invalidate_buffer(&mut self) {
        self.buffered = None;
        self.buffer_dirty = false;
    }

    /// Model one guest command and return its duration in T-states.
    pub(crate) fn access(&mut self, access: Access, drive: u8, record: u32, now: u64) -> u64 {
        self.last_now = self.last_now.max(now);
        let start = now + self.skipped;
        let end = match access {
            Access::Read => self.read(drive, record, start),
            Access::Write => self.write(drive, record, start),
            Access::Flush => self.write_back(start),
        };
        let duration = end - start;
        self.horizon = self.horizon.max(end);
        self.stats.disk_tstates += duration;
        if self.config.mode == DiskTimingMode::Account {
            self.skipped += duration;
        }
        duration
    }

    fn deblocks(&self) -> bool {
        self.config.profile.records_per_sector() > 1
    }

    fn read(&mut self, drive: u8, record: u32, start: u64) -> u64 {
        self.stats.record_reads += 1;
        let sector = record / self.config.profile.records_per_sector();
        if !self.deblocks() {
            self.stats.sector_reads += 1;
            return self.transfer(drive, sector, start);
        }
        self.load_buffer(drive, sector, start)
    }

    fn write(&mut self, drive: u8, record: u32, start: u64) -> u64 {
        self.stats.record_writes += 1;
        let sector = record / self.config.profile.records_per_sector();
        if !self.deblocks() {
            self.stats.sector_writes += 1;
            return self.transfer(drive, sector, start);
        }
        // A deblocking BIOS pre-reads the host sector, merges the record and
        // defers the physical write until the buffer moves or is flushed.
        let end = self.load_buffer(drive, sector, start);
        self.buffer_dirty = true;
        end
    }

    fn load_buffer(&mut self, drive: u8, sector: u32, start: u64) -> u64 {
        let wanted = Buffered { drive, sector };
        if self.buffered == Some(wanted) {
            self.stats.buffer_hits += 1;
            return start;
        }
        let time = self.write_back(start);
        self.stats.sector_reads += 1;
        let end = self.transfer(drive, sector, time);
        self.buffered = Some(wanted);
        end
    }

    fn write_back(&mut self, start: u64) -> u64 {
        let Some(buffered) = self.buffered.filter(|_| self.buffer_dirty) else {
            return start;
        };
        self.buffer_dirty = false;
        self.stats.sector_writes += 1;
        self.transfer(buffered.drive, buffered.sector, start)
    }

    /// Move to one physical sector and pass it under the head.
    fn transfer(&mut self, drive: u8, sector: u32, start: u64) -> u64 {
        let profile = self.config.profile;
        let per_track = u32::from(profile.sectors_per_track);
        let track = sector / per_track;
        let cylinder = track / u32::from(profile.heads);
        let slot = profile.slot(sector % per_track);
        let revolution = u64::from(self.config.clock_hz) * 60 / u64::from(profile.rpm);
        let index = usize::from(drive) % DRIVE_COUNT;
        let mut head = self.heads[index];
        let mut time = start;

        if !head.active || time.saturating_sub(head.last_end) > self.micros(profile.idle_us.into())
        {
            let ready = self.micros(profile.ready_us.into());
            time += ready;
            self.stats.ready_waits += 1;
            self.stats.ready_tstates += ready;
            head.active = true;
        }

        if cylinder != head.cylinder {
            let distance = u64::from(cylinder.abs_diff(head.cylinder));
            let seek = distance * self.micros(profile.step_us.into())
                + self.micros(profile.settle_us.into());
            time += seek;
            self.stats.seeks += 1;
            self.stats.cylinders_stepped += distance;
            self.stats.seek_tstates += seek;
            head.cylinder = cylinder;
        }
        self.stats.max_cylinder = self.stats.max_cylinder.max(cylinder);

        // Every drive's index hole passes at guest time zero.
        let sector_start = revolution * u64::from(slot) / u64::from(per_track);
        let sector_end = revolution * u64::from(slot + 1) / u64::from(per_track);
        let angle = time % revolution;
        let wait = (sector_start + revolution - angle) % revolution;
        time += wait;
        self.stats.rotation_tstates += wait;

        let transfer = sector_end - sector_start;
        time += transfer;
        self.stats.transfer_tstates += transfer;

        head.last_end = time;
        self.heads[index] = head;
        time
    }

    fn micros(&self, micros: u64) -> u64 {
        micros * u64::from(self.config.clock_hz) / 1_000_000
    }
}

fn gcd(mut a: u32, mut b: u32) -> u32 {
    while b != 0 {
        (a, b) = (b, a % b);
    }
    a
}

#[cfg(test)]
mod tests {
    use super::*;

    const CLOCK: u64 = DiskTimingConfig::DEFAULT_CLOCK_HZ as u64;

    fn model(profile: DiskTimingProfile) -> DiskTiming {
        DiskTiming::new(DiskTimingConfig::new(profile, DiskTimingMode::Account), 0)
    }

    fn ms(tstates: u64) -> u64 {
        tstates * 1_000 / CLOCK
    }

    #[test]
    fn built_in_profiles_are_valid_and_have_their_nominal_capacity() {
        for profile in DiskTimingProfile::BUILT_IN {
            assert!(profile.is_valid(), "{}", profile.name);
            assert_eq!(DiskTimingProfile::named(profile.name), Some(profile));
        }
        assert_eq!(DiskTimingProfile::EIGHT_INCH_SSSD.capacity_bytes(), 256_256);
        assert_eq!(DiskTimingProfile::FIVE_INCH_DSDD.capacity_bytes(), 409_600);
        assert_eq!(DiskTimingProfile::THREE_INCH_DSDD.capacity_bytes(), 737_280);
        assert_eq!(DiskTimingProfile::named("tape"), None);
    }

    #[test]
    fn skew_tables_match_the_classic_layouts() {
        let eight = DiskTimingProfile::EIGHT_INCH_SSSD;
        let table: [u32; 26] = core::array::from_fn(|logical| eight.slot(logical as u32));
        // The CP/M 2.2 skew-6 table, zero-based: 1,7,13,19,25,5,11,... - 1.
        assert_eq!(
            table,
            [
                0, 6, 12, 18, 24, 4, 10, 16, 22, 2, 8, 14, 20, 1, 7, 13, 19, 25, 5, 11, 17, 23, 3,
                9, 15, 21
            ]
        );
        let mut even = DiskTimingProfile::FIVE_INCH_DSDD;
        even.skew = 2;
        let table: [u32; 10] = core::array::from_fn(|logical| even.slot(logical as u32));
        assert_eq!(table, [0, 2, 4, 6, 8, 1, 3, 5, 7, 9]);
    }

    #[test]
    fn first_access_pays_head_load_then_rotation_and_transfer() {
        let mut timing = model(DiskTimingProfile::EIGHT_INCH_SSSD);
        let duration = timing.access(Access::Read, 0, 0, 0);
        let revolution = CLOCK / 6;
        let ready = 35 * CLOCK / 1_000;
        // Head load ends 35 ms in; sector 0 next starts at one revolution.
        assert_eq!(duration, revolution + revolution / 26);
        let stats = timing.stats;
        assert_eq!(stats.ready_waits, 1);
        assert_eq!(stats.ready_tstates, ready);
        assert_eq!(stats.rotation_tstates, revolution - ready);
        assert_eq!(stats.seeks, 0);
        assert_eq!(stats.sector_reads, 1);
    }

    #[test]
    fn eight_inch_sequential_reads_take_about_a_second_per_track_with_skew_6() {
        let mut timing = model(DiskTimingProfile::EIGHT_INCH_SSSD);
        let mut now = 0;
        // Allow the guest 3 ms per record, which skew 6 is designed to hide.
        for record in 0..26 {
            timing.access(Access::Read, 0, record, now);
            now += 3 * CLOCK / 1_000;
        }
        let report = timing.report(now);
        let track_ms = ms(report.stats.disk_tstates);
        assert!((1_000..=1_200).contains(&track_ms), "{track_ms} ms");
        assert_eq!(report.modelled_tstates, now + report.stats.disk_tstates);
    }

    #[test]
    fn seeks_cost_steps_plus_settle_and_drives_keep_separate_heads() {
        let mut timing = model(DiskTimingProfile::EIGHT_INCH_SSSD);
        timing.access(Access::Read, 0, 0, 0);
        timing.access(Access::Read, 1, 26 * 10, 0);
        assert_eq!(timing.stats.seeks, 1);
        assert_eq!(timing.stats.cylinders_stepped, 10);
        assert_eq!(timing.stats.seek_tstates, (10 * 8 + 8) * CLOCK / 1_000);
        // Drive 0 is still on cylinder 0.
        timing.access(Access::Read, 0, 1, 0);
        assert_eq!(timing.stats.seeks, 1);
        assert_eq!(timing.stats.max_cylinder, 10);
    }

    #[test]
    fn deblocking_reads_hit_the_buffer_and_writes_are_deferred_until_flush() {
        let mut timing = model(DiskTimingProfile::FIVE_INCH_DSDD);
        for record in 0..4 {
            timing.access(Access::Read, 0, record, 0);
        }
        assert_eq!(timing.stats.sector_reads, 1);
        assert_eq!(timing.stats.buffer_hits, 3);

        assert!(timing.access(Access::Write, 0, 1, 0) == 0);
        assert!(timing.report(0).write_pending);
        assert_eq!(timing.stats.sector_writes, 0);
        assert!(timing.access(Access::Flush, 0, 0, 0) > 0);
        assert_eq!(timing.stats.sector_writes, 1);
        assert!(!timing.report(0).write_pending);
        assert_eq!(timing.access(Access::Flush, 0, 0, 0), 0);

        // Moving a dirty buffer writes it back before the pre-read.
        timing.access(Access::Write, 0, 1, 0);
        timing.access(Access::Read, 0, 4, 0);
        assert_eq!(timing.stats.sector_writes, 2);
        assert_eq!(timing.stats.sector_reads, 2);
    }

    #[test]
    fn idle_drives_need_a_new_spin_up() {
        let mut timing = model(DiskTimingProfile::FIVE_INCH_DSDD);
        timing.access(Access::Read, 0, 0, 0);
        timing.access(Access::Read, 0, 4, 0);
        assert_eq!(timing.stats.ready_waits, 1);
        let later = timing.report(0).modelled_tstates + 3 * CLOCK;
        timing.access(Access::Read, 0, 8, later);
        assert_eq!(timing.stats.ready_waits, 2);
    }

    #[test]
    fn stall_mode_does_not_shift_the_model_clock() {
        let config =
            DiskTimingConfig::new(DiskTimingProfile::EIGHT_INCH_SSSD, DiskTimingMode::Stall);
        let mut timing = DiskTiming::new(config, 1_000);
        let duration = timing.access(Access::Read, 0, 0, 1_000);
        let report = timing.report(1_000 + duration);
        assert_eq!(report.guest_tstates, duration);
        assert_eq!(report.modelled_tstates, duration);
        // Reported before the command finishes, the pending wait still counts.
        let early = timing.report(1_000);
        assert_eq!(early.guest_tstates, 0);
        assert_eq!(early.modelled_tstates, duration);
    }
}
