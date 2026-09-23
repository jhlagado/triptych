use std::io;

use triptych_cpu_core::{CpuState, IoDirection, IoOperation};
use triptych_host_native::NativeExecutionRuntime;

#[test]
fn bare_runtime_loads_image_and_matches_wasm_surface_observations() {
    let mut runtime = NativeExecutionRuntime::new(&[0x3e, 0x42, 0xd3, 0x00, 0x76], 0x0100).unwrap();
    runtime.set_io_trace_enabled(true);

    while !runtime.is_halted() {
        assert_ne!(runtime.step().tstates, 0);
    }

    assert_eq!(runtime.take_output(), [0x42]);
    assert_eq!(
        runtime.take_io_trace(),
        [IoOperation {
            direction: IoDirection::Write,
            port: 0x4200,
            value: 0x42,
        }]
    );
    assert_eq!(runtime.cpu_state().a, 0x42);
    assert_eq!(runtime.cpu_state().pc, 0x0105);
}

#[test]
fn bare_runtime_applies_host_state_and_rejects_an_overflowing_image() {
    let mut runtime = NativeExecutionRuntime::new(&[0x76], 0x0100).unwrap();
    let state = CpuState {
        a: 0x55,
        pc: 0x0100,
        sp: 0x1234,
        f: triptych_cpu_core::CpuFlags {
            c: true,
            ..triptych_cpu_core::CpuFlags::default()
        },
        ..CpuState::default()
    };
    runtime.set_cpu_state(state);
    assert_eq!(runtime.cpu_state(), state);

    let error = NativeExecutionRuntime::new(&[0; 2], 0xffff)
        .err()
        .expect("overflowing image must be rejected");
    assert_eq!(error.kind(), io::ErrorKind::InvalidInput);
}
