use std::collections::VecDeque;
use std::fs;
use std::path::{Path, PathBuf};

use serde::Deserialize;
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use triptych_cpu_core::{
    Console, CpuState, Devices, DriveInfo, InterruptRequest, IoDirection, IoObserver, IoOperation,
    Machine, MachineMemory, SectorStore, StorageFault, BOOT_ROM_BYTES, RAM_BYTES, SECTOR_BYTES,
};

const FIXTURE_FORMAT: &str = "triptych.cpu.conformance.fixture.v1";
const RESULT_FORMAT: &str = "triptych.cpu.conformance.result.v1";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Fixture {
    format: String,
    id: String,
    initial: Initial,
    run: Run,
    observe: Observe,
    expected: Expected,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Initial {
    boot_rom: ByteImage,
    ram: ByteImage,
    drives: Vec<ByteImage>,
    serial_input: Vec<u8>,
}

#[derive(Deserialize)]
struct ByteImage {
    size: usize,
    fill: u8,
    patches: Vec<BytePatch>,
}

#[derive(Deserialize)]
struct BytePatch {
    address: usize,
    bytes: Vec<u8>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Run {
    max_steps: u64,
    max_t_states: u64,
    interrupts: Vec<ScheduledInterrupt>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ScheduledInterrupt {
    after_step: u64,
    kind: String,
    data: u8,
}

#[derive(Deserialize)]
struct Observe {
    cpu: Vec<String>,
    ram: Vec<RamRange>,
}

#[derive(Deserialize)]
struct RamRange {
    address: usize,
    length: usize,
}

#[derive(Deserialize)]
struct Expected {
    result: Value,
    digest: String,
}

#[derive(Default)]
struct TestConsole {
    input: VecDeque<u8>,
    output: Vec<u8>,
}

impl Console for TestConsole {
    fn receive(&mut self) -> Option<u8> {
        self.input.pop_front()
    }

    fn transmit(&mut self, byte: u8) {
        self.output.push(byte);
    }

    fn reset(&mut self) {
        self.input.clear();
        self.output.clear();
    }
}

struct TestStore {
    drives: Vec<Vec<u8>>,
}

impl SectorStore for TestStore {
    fn drive_info(&self, drive: u8) -> Option<DriveInfo> {
        let image = self.drives.get(usize::from(drive))?;
        Some(DriveInfo {
            sectors: u32::try_from(image.len() / SECTOR_BYTES).ok()?,
            writable: true,
        })
    }

    fn read_sector(
        &mut self,
        drive: u8,
        lba: u32,
        output: &mut [u8; SECTOR_BYTES],
    ) -> Result<(), StorageFault> {
        let image = self.drives.get(usize::from(drive)).ok_or(StorageFault)?;
        let start = usize::try_from(lba)
            .ok()
            .and_then(|sector| sector.checked_mul(SECTOR_BYTES))
            .ok_or(StorageFault)?;
        output.copy_from_slice(image.get(start..start + SECTOR_BYTES).ok_or(StorageFault)?);
        Ok(())
    }

    fn write_sector(
        &mut self,
        drive: u8,
        lba: u32,
        input: &[u8; SECTOR_BYTES],
    ) -> Result<(), StorageFault> {
        let image = self
            .drives
            .get_mut(usize::from(drive))
            .ok_or(StorageFault)?;
        let start = usize::try_from(lba)
            .ok()
            .and_then(|sector| sector.checked_mul(SECTOR_BYTES))
            .ok_or(StorageFault)?;
        image
            .get_mut(start..start + SECTOR_BYTES)
            .ok_or(StorageFault)?
            .copy_from_slice(input);
        Ok(())
    }

    fn flush(&mut self, drive: u8) -> Result<(), StorageFault> {
        self.drives
            .get(usize::from(drive))
            .map(|_| ())
            .ok_or(StorageFault)
    }
}

#[derive(Default)]
struct Transcript(Vec<IoOperation>);

impl IoObserver for Transcript {
    fn observe(&mut self, operation: IoOperation) {
        self.0.push(operation);
    }
}

#[test]
fn all_language_neutral_fixtures_match_exactly() {
    for path in fixture_paths() {
        let fixture: Fixture = serde_json::from_slice(&fs::read(&path).unwrap())
            .unwrap_or_else(|error| panic!("{}: {error}", path.display()));
        assert_eq!(fixture.format, FIXTURE_FORMAT, "{}", fixture.id);
        run_fixture(&fixture);
    }
}

fn fixture_paths() -> Vec<PathBuf> {
    let directory = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../test/conformance/fixtures");
    let mut paths: Vec<_> = fs::read_dir(directory)
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .filter(|path| path.extension().is_some_and(|value| value == "json"))
        .collect();
    paths.sort();
    paths
}

fn run_fixture(fixture: &Fixture) {
    assert_eq!(fixture.initial.boot_rom.size, BOOT_ROM_BYTES);
    assert_eq!(fixture.initial.ram.size, RAM_BYTES);

    let boot_rom: Box<[u8; BOOT_ROM_BYTES]> = materialize(&fixture.initial.boot_rom)
        .into_boxed_slice()
        .try_into()
        .unwrap();
    let mut ram: Box<[u8; RAM_BYTES]> = materialize(&fixture.initial.ram)
        .into_boxed_slice()
        .try_into()
        .unwrap();
    let drives = fixture.initial.drives.iter().map(materialize).collect();
    let mut console = TestConsole::default();
    let mut sectors = TestStore { drives };
    let mut transcript = Transcript::default();
    let mut machine = Machine::new();

    {
        let mut devices = Devices::new(&mut console, &mut sectors).with_observer(&mut transcript);
        machine.reset(&mut devices);
    }
    console
        .input
        .extend(fixture.initial.serial_input.iter().copied());

    let (stop, steps, tstates) = {
        let mut memory = MachineMemory::new(&mut ram, &boot_rom);
        let mut devices = Devices::new(&mut console, &mut sectors).with_observer(&mut transcript);
        run_steps(fixture, &mut machine, &mut memory, &mut devices)
    };

    let state = machine.cpu_state();
    let cpu = observed_cpu(&state, &fixture.observe.cpu);
    let ram_observations: Vec<Value> = fixture
        .observe
        .ram
        .iter()
        .map(|range| {
            json!({
                "address": range.address,
                "bytes": &ram[range.address..range.address + range.length],
            })
        })
        .collect();
    let drive_digests: Vec<String> = sectors.drives.iter().map(|image| sha256(image)).collect();
    let io: Vec<Value> = transcript
        .0
        .iter()
        .map(|operation| {
            json!({
                "direction": match operation.direction {
                    IoDirection::Read => "read",
                    IoDirection::Write => "write",
                },
                "port": operation.port,
                "value": operation.value,
            })
        })
        .collect();

    let result = json!({
        "format": RESULT_FORMAT,
        "fixture": fixture.id,
        "stop": stop,
        "steps": steps,
        "tStates": tstates,
        "cpu": cpu,
        "bootRomEnabled": machine.boot_rom_enabled(),
        "ramSha256": sha256(ram.as_slice()),
        "ram": ram_observations,
        "driveSha256": drive_digests,
        "serialOutput": console.output,
        "io": io,
    });

    assert_eq!(result, fixture.expected.result, "{} result", fixture.id);
    let canonical = canonical_transcript(&result);
    assert_eq!(
        sha256(canonical.as_bytes()),
        fixture.expected.digest,
        "{} digest",
        fixture.id
    );
}

fn run_steps(
    fixture: &Fixture,
    machine: &mut Machine,
    memory: &mut MachineMemory<'_>,
    devices: &mut Devices<'_>,
) -> (&'static str, u64, u64) {
    let mut steps = 0;
    let mut tstates = 0;
    while steps < fixture.run.max_steps {
        let next_step = steps + 1;
        let interrupt = fixture
            .run
            .interrupts
            .iter()
            .find(|interrupt| interrupt.after_step == next_step)
            .map_or(InterruptRequest::None, |interrupt| {
                assert_eq!(interrupt.kind, "maskable", "{}", fixture.id);
                assert_eq!(interrupt.data, 0xff, "{}", fixture.id);
                InterruptRequest::MaskableFf
            });
        let result = machine.step(memory, devices, interrupt);
        steps += 1;
        tstates += u64::from(result.tstates);
        if result.halted {
            return ("halt", steps, tstates);
        }
        if tstates >= fixture.run.max_t_states {
            return ("tstate-limit", steps, tstates);
        }
    }
    ("step-limit", steps, tstates)
}

fn materialize(image: &ByteImage) -> Vec<u8> {
    let mut bytes = vec![image.fill; image.size];
    for patch in &image.patches {
        bytes[patch.address..patch.address + patch.bytes.len()].copy_from_slice(&patch.bytes);
    }
    bytes
}

fn observed_cpu(state: &CpuState, fields: &[String]) -> Value {
    let mut result = Map::new();
    let mut fields = fields.to_vec();
    fields.sort();
    for field in fields {
        let value = match field.as_str() {
            "a" => json!(state.a),
            "a_prime" => json!(state.a_prime),
            "b" => json!(state.b),
            "b_prime" => json!(state.b_prime),
            "c" => json!(state.c),
            "c_prime" => json!(state.c_prime),
            "d" => json!(state.d),
            "d_prime" => json!(state.d_prime),
            "e" => json!(state.e),
            "e_prime" => json!(state.e_prime),
            "h" => json!(state.h),
            "h_prime" => json!(state.h_prime),
            "l" => json!(state.l),
            "l_prime" => json!(state.l_prime),
            "i" => json!(state.i),
            "ix" => json!(state.ix),
            "iy" => json!(state.iy),
            "r" => json!(state.r),
            "sp" => json!(state.sp),
            "pc" => json!(state.pc),
            "imode" => json!(state.imode),
            "iff1" => json!(u8::from(state.iff1)),
            "iff2" => json!(u8::from(state.iff2)),
            "halted" => json!(state.halted),
            value if value.starts_with("f_prime.") => flag_value(&state.f_prime, &value[8..]),
            value if value.starts_with("f.") => flag_value(&state.f, &value[2..]),
            _ => panic!("unsupported CPU observation {field}"),
        };
        result.insert(field, value);
    }
    Value::Object(result)
}

fn flag_value(flags: &triptych_cpu_core::CpuFlags, name: &str) -> Value {
    let value = match name {
        "s" => flags.s,
        "z" => flags.z,
        "y" => flags.y,
        "h" => flags.h,
        "x" => flags.x,
        "p" => flags.p,
        "n" => flags.n,
        "c" => flags.c,
        _ => panic!("unsupported flag {name}"),
    };
    json!(u8::from(value))
}

fn sha256(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let mut result = String::with_capacity(64);
    for byte in digest {
        use std::fmt::Write;
        write!(result, "{byte:02x}").unwrap();
    }
    result
}

fn canonical_transcript(result: &Value) -> String {
    let result = result.as_object().unwrap();
    let mut lines = vec![
        "triptych-cpu-result-v1".to_owned(),
        format!("fixture={}", result["fixture"].as_str().unwrap()),
        format!("stop={}", result["stop"].as_str().unwrap()),
        format!("steps={}", result["steps"]),
        format!("tstates={}", result["tStates"]),
        format!(
            "boot-rom-enabled={}",
            u8::from(result["bootRomEnabled"].as_bool().unwrap())
        ),
    ];
    let mut cpu: Vec<_> = result["cpu"].as_object().unwrap().iter().collect();
    cpu.sort_by_key(|(field, _)| *field);
    for (field, value) in cpu {
        lines.push(format!(
            "cpu.{field}={}",
            value
                .as_u64()
                .unwrap_or_else(|| u64::from(value.as_bool().unwrap()))
        ));
    }
    lines.push(format!(
        "ram-sha256={}",
        result["ramSha256"].as_str().unwrap()
    ));
    let mut ram: Vec<_> = result["ram"].as_array().unwrap().iter().collect();
    ram.sort_by_key(|range| range["address"].as_u64().unwrap());
    for range in ram {
        lines.push(format!(
            "ram.{:04x}={}",
            range["address"].as_u64().unwrap(),
            json_bytes_hex(&range["bytes"])
        ));
    }
    let drives = result["driveSha256"].as_array().unwrap();
    lines.push(format!("drives={}", drives.len()));
    for (index, digest) in drives.iter().enumerate() {
        lines.push(format!("drive.{index}-sha256={}", digest.as_str().unwrap()));
    }
    lines.push(format!(
        "serial={}",
        json_bytes_hex(&result["serialOutput"])
    ));
    for (index, operation) in result["io"].as_array().unwrap().iter().enumerate() {
        lines.push(format!(
            "io.{index}={},{:04x},{:02x}",
            if operation["direction"] == "read" {
                "r"
            } else {
                "w"
            },
            operation["port"].as_u64().unwrap(),
            operation["value"].as_u64().unwrap(),
        ));
    }
    format!("{}\n", lines.join("\n"))
}

fn json_bytes_hex(value: &Value) -> String {
    value
        .as_array()
        .unwrap()
        .iter()
        .map(|byte| format!("{:02x}", byte.as_u64().unwrap()))
        .collect()
}
