use core::num::NonZeroU64;

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct CpuFlags {
    pub s: bool,
    pub z: bool,
    pub y: bool,
    pub h: bool,
    pub x: bool,
    pub p: bool,
    pub n: bool,
    pub c: bool,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct CpuState {
    pub a: u8,
    pub b: u8,
    pub c: u8,
    pub d: u8,
    pub e: u8,
    pub h: u8,
    pub l: u8,
    pub a_prime: u8,
    pub b_prime: u8,
    pub c_prime: u8,
    pub d_prime: u8,
    pub e_prime: u8,
    pub h_prime: u8,
    pub l_prime: u8,
    pub f: CpuFlags,
    pub f_prime: CpuFlags,
    pub ix: u16,
    pub iy: u16,
    pub i: u8,
    pub r: u8,
    pub sp: u16,
    pub pc: u16,
    pub imode: u8,
    pub iff1: bool,
    pub iff2: bool,
    pub halted: bool,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum InterruptRequest {
    #[default]
    None,
    /// Maskable interrupt with the selected engine's proven `$FF` acknowledge.
    MaskableFf,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct RunBudget {
    pub(crate) max_steps: NonZeroU64,
    pub(crate) max_tstates: NonZeroU64,
}

impl RunBudget {
    pub fn new(max_steps: NonZeroU64, max_tstates: NonZeroU64) -> Self {
        Self {
            max_steps,
            max_tstates,
        }
    }

    pub fn from_values(max_steps: u64, max_tstates: u64) -> Option<Self> {
        Some(Self::new(
            NonZeroU64::new(max_steps)?,
            NonZeroU64::new(max_tstates)?,
        ))
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct StepResult {
    pub tstates: u32,
    pub halted: bool,
    pub interrupt_accepted: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RunReason {
    Halted,
    StepLimit,
    TStateLimit,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct RunExit {
    pub reason: RunReason,
    pub steps: u64,
    pub tstates: u64,
}
