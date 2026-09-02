use std::env;
use std::error::Error;
use std::ffi::OsString;
use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::process;
use std::sync::atomic::{AtomicU64, Ordering};

use triptych_cpm_image::{CpmImage, CpmName};

static TEMPORARY_SEQUENCE: AtomicU64 = AtomicU64::new(0);

fn main() {
    if let Err(error) = run() {
        eprintln!("triptych-cpm: {error}");
        process::exit(1);
    }
}

fn run() -> Result<(), Box<dyn Error>> {
    let mut arguments = env::args_os().skip(1);
    let command = arguments.next().ok_or(USAGE)?;
    match command.to_str() {
        Some("create") => create(parse_exact_paths(arguments, 2, "create")?),
        Some("list") => list(parse_exact_paths(arguments, 1, "list")?),
        Some("import") => import(arguments),
        Some("export") => export(arguments),
        Some("help" | "--help" | "-h") => {
            println!("{USAGE}");
            Ok(())
        }
        Some(command) => Err(format!("unknown command {command:?}\n{USAGE}").into()),
        None => Err(format!("command must be UTF-8\n{USAGE}").into()),
    }
}

const USAGE: &str = "usage:
  triptych-cpm create SOURCE-IMAGE WORKING-IMAGE
  triptych-cpm list IMAGE
  triptych-cpm import IMAGE MAC-FILE [CPM-NAME]
  triptych-cpm export [--text] [--force] IMAGE CPM-NAME MAC-FILE";

fn create(paths: Vec<PathBuf>) -> Result<(), Box<dyn Error>> {
    let source = load_image(&paths[0])?;
    let bytes = source.into_working_bytes();
    write_atomic(&paths[1], &bytes, Publication::New)?;
    println!(
        "Created {} from {} ({} bytes).",
        paths[1].display(),
        paths[0].display(),
        bytes.len()
    );
    Ok(())
}

fn list(paths: Vec<PathBuf>) -> Result<(), Box<dyn Error>> {
    let image = load_image(&paths[0])?;
    println!("Name          Records       Bytes");
    for file in image.files()? {
        println!(
            "{:<12} {:>7} {:>11}",
            file.name,
            file.records,
            file.stored_bytes()
        );
    }
    let free = image.free_space()?;
    println!(
        "Free: {} allocation blocks ({} bytes); {} directory entries.",
        free.allocation_blocks, free.bytes, free.directory_entries
    );
    Ok(())
}

fn import(mut arguments: impl Iterator<Item = OsString>) -> Result<(), Box<dyn Error>> {
    let image_path = next_path(&mut arguments, "import IMAGE")?;
    let mac_path = next_path(&mut arguments, "import MAC-FILE")?;
    let supplied_name = arguments.next();
    if arguments.next().is_some() {
        return Err(format!("too many import arguments\n{USAGE}").into());
    }
    let cpm_name = match supplied_name {
        Some(name) => name.into_string().map_err(|_| "CP/M name must be UTF-8")?,
        None => mac_path
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or("MAC-FILE has no UTF-8 filename; supply CPM-NAME")?
            .to_owned(),
    };
    let canonical = CpmName::parse(&cpm_name)?.canonical().to_owned();
    let contents = fs::read(&mac_path)?;
    let image = load_image(&image_path)?;
    let replacement = image.install(&canonical, &contents)?;
    let stored = replacement
        .read(&canonical)?
        .ok_or("installed file was not found")?;
    write_atomic(&image_path, replacement.as_bytes(), Publication::Replace)?;
    println!(
        "Imported {} as {} ({} source bytes; {} CP/M records).",
        mac_path.display(),
        canonical,
        contents.len(),
        stored.records
    );
    Ok(())
}

fn export(mut arguments: impl Iterator<Item = OsString>) -> Result<(), Box<dyn Error>> {
    let mut text = false;
    let mut force = false;
    let mut positional = Vec::new();
    for argument in arguments.by_ref() {
        match argument.to_str() {
            Some("--text") => text = true,
            Some("--force") => force = true,
            Some(option) if option.starts_with('-') => {
                return Err(format!("unknown export option {option:?}\n{USAGE}").into())
            }
            _ => positional.push(argument),
        }
    }
    if positional.len() != 3 {
        return Err(format!("export requires IMAGE, CPM-NAME, and MAC-FILE\n{USAGE}").into());
    }
    let image_path = PathBuf::from(&positional[0]);
    let cpm_name = positional[1]
        .clone()
        .into_string()
        .map_err(|_| "CP/M name must be UTF-8")?;
    let mac_path = PathBuf::from(&positional[2]);
    let image = load_image(&image_path)?;
    let file = image
        .read(&cpm_name)?
        .ok_or_else(|| format!("CP/M disk: {} was not found", cpm_name.to_ascii_uppercase()))?;
    let bytes = if text {
        let end = file
            .bytes
            .iter()
            .rposition(|byte| *byte != 0x1a)
            .map_or(0, |index| index + 1);
        &file.bytes[..end]
    } else {
        file.bytes.as_slice()
    };
    write_atomic(
        &mac_path,
        bytes,
        if force {
            Publication::Replace
        } else {
            Publication::New
        },
    )?;
    println!(
        "Exported {} to {} ({} bytes{}).",
        file.name,
        mac_path.display(),
        bytes.len(),
        if text { "; CP/M text EOF trimmed" } else { "" }
    );
    Ok(())
}

fn load_image(path: &Path) -> Result<CpmImage, Box<dyn Error>> {
    CpmImage::from_bytes(fs::read(path)?).map_err(Into::into)
}

fn parse_exact_paths(
    arguments: impl Iterator<Item = OsString>,
    count: usize,
    command: &str,
) -> Result<Vec<PathBuf>, Box<dyn Error>> {
    let paths: Vec<_> = arguments.map(PathBuf::from).collect();
    if paths.len() != count {
        return Err(format!("{command} received the wrong number of arguments\n{USAGE}").into());
    }
    Ok(paths)
}

fn next_path(
    arguments: &mut impl Iterator<Item = OsString>,
    label: &str,
) -> Result<PathBuf, Box<dyn Error>> {
    arguments
        .next()
        .map(PathBuf::from)
        .ok_or_else(|| format!("missing {label}\n{USAGE}").into())
}

#[derive(Clone, Copy)]
enum Publication {
    New,
    Replace,
}

fn write_atomic(path: &Path, bytes: &[u8], publication: Publication) -> io::Result<()> {
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    let name = path.file_name().ok_or_else(|| {
        io::Error::new(io::ErrorKind::InvalidInput, "output path has no filename")
    })?;
    if matches!(publication, Publication::New) && path.exists() {
        return Err(io::Error::new(
            io::ErrorKind::AlreadyExists,
            format!("{} already exists", path.display()),
        ));
    }
    let sequence = TEMPORARY_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let temporary = parent.join(format!(
        ".{}.triptych-cpm-{}-{sequence}.tmp",
        name.to_string_lossy(),
        process::id()
    ));
    let result = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        if matches!(publication, Publication::Replace) {
            if let Ok(metadata) = fs::metadata(path) {
                fs::set_permissions(&temporary, metadata.permissions())?;
            }
            fs::rename(&temporary, path)
        } else {
            fs::hard_link(&temporary, path)?;
            fs::remove_file(&temporary)
        }
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}
