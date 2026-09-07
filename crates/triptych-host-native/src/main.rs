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
    let mut sectors = FileSectorStore::open_slots(&drive_paths)?;
    if let Some(expected) = arguments.image_bytes {
        sectors.require_image_bytes(expected)?;
    }
    let mut ram = Box::new([0; RAM_BYTES]);
    let mut machine = Machine::new();
    let mut console = match arguments.input.as_ref() {
        Some(input) if arguments.input_after.is_none() => TerminalConsole::scripted(input.bytes()),
        Some(_) => TerminalConsole::scripted([]),
        None => TerminalConsole::open(),
    };
    let budget = RunBudget::from_values(50_000, 500_000).expect("non-zero budget");
    let mut total_steps = 0_u64;
    let mut input_queued = arguments.input_after.is_none();

    loop {
        let exit = {
            let mut memory = MachineMemory::new(&mut ram, &boot_rom);
            let mut devices = Devices::new(&mut console, &mut sectors);
            machine.run_slice(&mut memory, &mut devices, budget)
        };
        total_steps = total_steps.saturating_add(exit.steps);
        if !input_queued
            && arguments
                .input_after
                .as_ref()
                .is_some_and(|suffix| console.captured_output().ends_with(suffix.as_bytes()))
        {
            console.enqueue_scripted(
                arguments
                    .input
                    .as_ref()
                    .expect("input-after requires input")
                    .bytes(),
            );
            input_queued = true;
        }
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
    drives: Vec<Option<PathBuf>>,
    image_bytes: Option<u64>,
    input: Option<String>,
    input_after: Option<String>,
    stop_after: Option<String>,
    max_steps: Option<u64>,
}

fn parse_arguments(arguments: impl Iterator<Item = OsString>) -> Result<Arguments, Box<dyn Error>> {
    let mut positional = Vec::new();
    let mut input = None;
    let mut input_after = None;
    let mut stop_after = None;
    let mut max_steps = None;
    let mut slots = None;
    let mut selected_drives = Vec::new();
    let mut image_bytes = None;
    let mut arguments = arguments;
    while let Some(argument) = arguments.next() {
        match argument.to_str() {
            Some("--slots") => {
                if slots.is_some() {
                    return Err("--slots may be specified only once".into());
                }
                let count = next_decimal(&mut arguments, "--slots")?;
                if !(1..=16).contains(&count) {
                    return Err("--slots must be 1 through 16".into());
                }
                slots = Some(count as usize);
            }
            Some("--drive") => {
                let letter = next_utf8(&mut arguments, "--drive")?;
                if letter.len() != 1 || !(b'A'..=b'P').contains(&letter.as_bytes()[0]) {
                    return Err("--drive requires one uppercase letter A through P".into());
                }
                let index = usize::from(letter.as_bytes()[0] - b'A');
                if selected_drives.iter().any(|(drive, _)| *drive == index) {
                    return Err(format!("drive {letter} is specified more than once").into());
                }
                let path = arguments
                    .next()
                    .ok_or("--drive requires an image path after its letter")?;
                if path.is_empty() || path.to_str().is_some_and(|value| value.starts_with("--")) {
                    return Err("--drive requires an image path after its letter (prefix option-like paths with ./)".into());
                }
                selected_drives.push((index, PathBuf::from(path)));
            }
            Some("--image-bytes") => {
                if image_bytes.is_some() {
                    return Err("--image-bytes may be specified only once".into());
                }
                let bytes = next_decimal(&mut arguments, "--image-bytes")?;
                if bytes == 0 || !bytes.is_multiple_of(512) {
                    return Err("--image-bytes must be a positive multiple of 512".into());
                }
                image_bytes = Some(bytes);
            }
            Some("--input-ascii") => {
                input = Some(next_utf8(&mut arguments, "--input-ascii")?);
            }
            Some("--input-after") => {
                input_after = Some(next_utf8(&mut arguments, "--input-after")?);
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
        .ok_or("usage: triptych-host-native [OPTIONS] BOOT-ROM DRIVE-IMAGE [DRIVE-IMAGE ...]\n       triptych-host-native [OPTIONS] --slots N --drive A IMAGE [--drive LETTER IMAGE ...] BOOT-ROM")?;
    let positional_drives: Vec<_> = positional.collect();
    let drives = if let Some(count) = slots {
        if !positional_drives.is_empty() {
            return Err(
                "explicit --slots/--drive mode cannot contain positional drive images".into(),
            );
        }
        let mut drives = vec![None; count];
        for (index, path) in selected_drives {
            if index >= count {
                return Err(format!(
                    "drive {} is outside the {count} configured slots",
                    char::from(b'A' + index as u8)
                )
                .into());
            }
            drives[index] = Some(path);
        }
        if drives[0].is_none() {
            return Err("explicit drive configuration requires boot media in A".into());
        }
        drives
    } else {
        if !selected_drives.is_empty() {
            return Err("--drive requires --slots".into());
        }
        if positional_drives.is_empty() {
            return Err("at least one drive image is required".into());
        }
        if positional_drives.len() > 16 {
            return Err("at most 16 drive images may be configured".into());
        }
        positional_drives.into_iter().map(Some).collect()
    };
    if input_after.is_some() && input.is_none() {
        return Err("--input-after requires --input-ascii".into());
    }
    Ok(Arguments {
        rom,
        drives,
        image_bytes,
        input,
        input_after,
        stop_after,
        max_steps,
    })
}

fn next_decimal(
    arguments: &mut impl Iterator<Item = OsString>,
    option: &str,
) -> Result<u64, Box<dyn Error>> {
    let value = next_utf8(arguments, option)?;
    if value.is_empty() || !value.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err(format!("{option} requires a decimal integer").into());
    }
    value.parse::<u64>().map_err(Into::into)
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
