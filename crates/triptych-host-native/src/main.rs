use std::env;
use std::error::Error;
use std::ffi::OsString;
use std::fs;
use std::path::PathBuf;

use triptych_cpu_core::{
    Devices, Machine, MachineMemory, RunBudget, RunReason, BOOT_ROM_BYTES, RAM_BYTES,
};
use triptych_host_native::{FileSectorStore, TerminalConsole};

fn main() {
    if let Err(error) = run() {
        eprintln!("triptych-host-native: {error}");
        std::process::exit(1);
    }
}

fn run() -> Result<(), Box<dyn Error>> {
    let arguments = parse_arguments(env::args_os().skip(1))?;
    let rom_path = arguments.rom;
    let drive_paths = arguments.drives;

    let rom_bytes = fs::read(&rom_path)?;
    let boot_rom: [u8; BOOT_ROM_BYTES] = rom_bytes.try_into().map_err(|bytes: Vec<u8>| {
        format!(
            "{} contains {} bytes; the boot ROM must contain exactly {}",
            rom_path.display(),
            bytes.len(),
            BOOT_ROM_BYTES
        )
    })?;
    let mut ram = Box::new([0; RAM_BYTES]);
    let mut machine = Machine::new();
    let mut console = match arguments.input {
        Some(input) => TerminalConsole::scripted(input.bytes()),
        None => TerminalConsole::open(),
    };
    let mut sectors = FileSectorStore::open(&drive_paths)?;
    let budget = RunBudget::from_values(50_000, 500_000).expect("non-zero budget");
    let mut total_steps = 0_u64;

    loop {
        let exit = {
            let mut memory = MachineMemory::new(&mut ram, &boot_rom);
            let mut devices = Devices::new(&mut console, &mut sectors);
            machine.run_slice(&mut memory, &mut devices, budget)
        };
        total_steps = total_steps.saturating_add(exit.steps);
        if arguments
            .stop_after
            .as_ref()
            .is_some_and(|suffix| console.captured_output().ends_with(suffix.as_bytes()))
        {
            return Ok(());
        }
        if exit.reason == RunReason::Halted {
            return Ok(());
        }
        if arguments
            .max_steps
            .is_some_and(|maximum| total_steps >= maximum)
        {
            return Err(format!("step limit reached after {total_steps} instructions").into());
        }
        std::thread::yield_now();
    }
}

struct Arguments {
    rom: PathBuf,
    drives: Vec<PathBuf>,
    input: Option<String>,
    stop_after: Option<String>,
    max_steps: Option<u64>,
}

fn parse_arguments(arguments: impl Iterator<Item = OsString>) -> Result<Arguments, Box<dyn Error>> {
    let mut positional = Vec::new();
    let mut input = None;
    let mut stop_after = None;
    let mut max_steps = None;
    let mut arguments = arguments;
    while let Some(argument) = arguments.next() {
        match argument.to_str() {
            Some("--input-ascii") => {
                input = Some(next_utf8(&mut arguments, "--input-ascii")?);
            }
            Some("--stop-after") => {
                stop_after = Some(next_utf8(&mut arguments, "--stop-after")?);
            }
            Some("--max-steps") => {
                max_steps = Some(next_utf8(&mut arguments, "--max-steps")?.parse::<u64>()?);
            }
            Some(value) if value.starts_with('-') => {
                return Err(format!("unknown option {value}").into());
            }
            _ => positional.push(PathBuf::from(argument)),
        }
    }
    let mut positional = positional.into_iter();
    let rom = positional
        .next()
        .ok_or("usage: triptych-host-native [OPTIONS] BOOT-ROM DRIVE-IMAGE [DRIVE-IMAGE ...]")?;
    let drives: Vec<_> = positional.collect();
    if drives.is_empty() {
        return Err("at least one drive image is required".into());
    }
    Ok(Arguments {
        rom,
        drives,
        input,
        stop_after,
        max_steps,
    })
}

fn next_utf8(
    arguments: &mut impl Iterator<Item = OsString>,
    option: &str,
) -> Result<String, Box<dyn Error>> {
    arguments
        .next()
        .ok_or_else(|| format!("{option} requires a value"))?
        .into_string()
        .map_err(|_| format!("{option} requires UTF-8 text").into())
}
