use crate::{CpuFlags, CpuState};

pub(crate) trait EngineBus {
    fn read(&mut self, address: u16) -> u8;
    fn write(&mut self, address: u16, value: u8);
    fn input(&mut self, port: u16) -> u8;
    fn output(&mut self, port: u16, value: u8);
    fn tick(&mut self, tstates: u32);
}

struct CellBus<'a, B: EngineBus>(&'a mut B);

impl<B: EngineBus> z80::Bus for CellBus<'_, B> {
    fn read(&mut self, address: u16) -> u8 {
        self.0.read(address)
    }

    fn write(&mut self, address: u16, value: u8) {
        self.0.write(address, value);
    }

    fn input(&mut self, port: u16) -> u8 {
        self.0.input(port)
    }

    fn output(&mut self, port: u16, value: u8) {
        self.0.output(port, value);
    }

    fn contend(&mut self, _address: u16, _cycles: u32) {}

    fn tick(&mut self, tstates: u32) {
        self.0.tick(tstates);
    }
}

#[derive(Debug, Default)]
pub(crate) struct Adapter {
    cpu: z80::Cpu,
}

impl Adapter {
    pub(crate) fn new() -> Self {
        Self::default()
    }

    pub(crate) fn reset(&mut self) {
        self.cpu.reset();
    }

    pub(crate) fn step(&mut self, bus: &mut impl EngineBus) {
        self.cpu.step(&mut CellBus(bus));
    }

    pub(crate) fn interrupt_maskable_ff(&mut self, bus: &mut impl EngineBus) -> bool {
        self.cpu.interrupt(&mut CellBus(bus))
    }

    pub(crate) fn halted(&self) -> bool {
        self.cpu.halted
    }

    pub(crate) fn state(&self) -> CpuState {
        let registers = &self.cpu.regs;
        CpuState {
            a: registers.a,
            b: registers.b,
            c: registers.c,
            d: registers.d,
            e: registers.e,
            h: registers.h,
            l: registers.l,
            a_prime: registers.a_,
            b_prime: registers.b_,
            c_prime: registers.c_,
            d_prime: registers.d_,
            e_prime: registers.e_,
            h_prime: registers.h_,
            l_prime: registers.l_,
            f: flags(registers.f),
            f_prime: flags(registers.f_),
            ix: registers.ix,
            iy: registers.iy,
            i: registers.i,
            r: registers.r,
            sp: registers.sp,
            pc: registers.pc,
            imode: self.cpu.im,
            iff1: self.cpu.iff1,
            iff2: self.cpu.iff2,
            halted: self.cpu.halted,
        }
    }

    #[cfg(feature = "conformance")]
    pub(crate) fn install_architectural_state(&mut self, state: CpuState) {
        let registers = &mut self.cpu.regs;
        registers.a = state.a;
        registers.b = state.b;
        registers.c = state.c;
        registers.d = state.d;
        registers.e = state.e;
        registers.h = state.h;
        registers.l = state.l;
        registers.a_ = state.a_prime;
        registers.b_ = state.b_prime;
        registers.c_ = state.c_prime;
        registers.d_ = state.d_prime;
        registers.e_ = state.e_prime;
        registers.h_ = state.h_prime;
        registers.l_ = state.l_prime;
        registers.f = encode_flags(state.f);
        registers.f_ = encode_flags(state.f_prime);
        registers.ix = state.ix;
        registers.iy = state.iy;
        registers.i = state.i;
        registers.r = state.r;
        registers.sp = state.sp;
        registers.pc = state.pc;
        self.cpu.im = state.imode;
        self.cpu.iff1 = state.iff1;
        self.cpu.iff2 = state.iff2;
        self.cpu.halted = state.halted;
    }
}

fn flags(value: u8) -> CpuFlags {
    CpuFlags {
        s: value & 0x80 != 0,
        z: value & 0x40 != 0,
        y: value & 0x20 != 0,
        h: value & 0x10 != 0,
        x: value & 0x08 != 0,
        p: value & 0x04 != 0,
        n: value & 0x02 != 0,
        c: value & 0x01 != 0,
    }
}

#[cfg(feature = "conformance")]
fn encode_flags(flags: CpuFlags) -> u8 {
    (u8::from(flags.s) << 7)
        | (u8::from(flags.z) << 6)
        | (u8::from(flags.y) << 5)
        | (u8::from(flags.h) << 4)
        | (u8::from(flags.x) << 3)
        | (u8::from(flags.p) << 2)
        | (u8::from(flags.n) << 1)
        | u8::from(flags.c)
}
