use triptych_cpu_core::CpuState;
use triptych_host_native::NativeExecutionRuntime;

const ENTRY: u16 = 0x0100;
const OUTPUT_VECTOR: u16 = 0x22a4;
const INPUT_VECTOR: u16 = 0x22a7;
const OUTPUT_STUB: u16 = 0xf000;
const INPUT_STUB: u16 = 0xf003;
const STACK: u16 = 0xf800;
const IMAGE: &[u8] = include_bytes!("../../../test/fixtures/skate-provider-trace.com");

fn patch_vector(runtime: &mut NativeExecutionRuntime, vector: u16, target: u16) {
    let memory = runtime.memory_mut();
    let offset = usize::from(vector);
    memory[offset..offset + 3].copy_from_slice(&[0xc3, (target & 0xff) as u8, (target >> 8) as u8]);
}

#[test]
fn generated_skate_program_runs_through_the_native_triptych_serial_gateway() {
    let mut runtime = NativeExecutionRuntime::new(IMAGE, ENTRY).unwrap();
    runtime.memory_mut()[0] = 0x76; // COM return target used by the CP/M proof.
    runtime.memory_mut()[usize::from(OUTPUT_STUB)..usize::from(OUTPUT_STUB) + 3]
        .copy_from_slice(&[0xd3, 0x00, 0xc9]);
    runtime.memory_mut()[usize::from(INPUT_STUB)..usize::from(INPUT_STUB) + 3]
        .copy_from_slice(&[0xdb, 0x00, 0xc9]);
    patch_vector(&mut runtime, OUTPUT_VECTOR, OUTPUT_STUB);
    patch_vector(&mut runtime, INPUT_VECTOR, INPUT_STUB);
    let mut state: CpuState = runtime.cpu_state();
    state.sp = STACK;
    runtime.set_cpu_state(state);
    runtime.queue_input([b'Q']);

    let mut halted = false;
    for steps in 0..2_000_000 {
        if runtime.is_halted() {
            assert!(steps > 0);
            halted = true;
            break;
        }
        assert_ne!(runtime.step().tstates, 0);
    }

    let output = runtime.take_output();
    assert!(
        halted,
        "pc={:04x} output={output:?}",
        runtime.cpu_state().pc
    );
    assert_eq!(output, b"Q\r\n");
    assert!(runtime.is_halted());
}
