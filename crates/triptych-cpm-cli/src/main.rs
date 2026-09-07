use std::env;
use std::error::Error;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process;

use triptych_cpm_image::{CpmGeometry, CpmImage, CpmName};

mod native_file;
use native_file::{LockedFile, Output};

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
        Some("format") => format_image(arguments),
        Some("migrate") => migrate_image(arguments),
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
  triptych-cpm format FORMAT SYSTEM-AREA NEW-IMAGE
  triptych-cpm migrate FORMAT SOURCE-IMAGE SYSTEM-AREA NEW-IMAGE
  triptych-cpm list IMAGE
  triptych-cpm import IMAGE MAC-FILE [CPM-NAME]
  triptych-cpm export [--text] [--force] IMAGE CPM-NAME MAC-FILE";

fn next_geometry(
    arguments: &mut impl Iterator<Item = OsString>,
) -> Result<CpmGeometry, Box<dyn Error>> {
    match arguments.next().as_deref().and_then(|value| value.to_str()) {
        Some("ibm3740") => Ok(CpmGeometry::Ibm3740),
        Some("triptych-cpm-2m-v1") => Ok(CpmGeometry::Triptych2M),
        Some("triptych-cpm-8m-v1") => Ok(CpmGeometry::Triptych8M),
        _ => Err("FORMAT must be ibm3740, triptych-cpm-2m-v1 or triptych-cpm-8m-v1".into()),
    }
}

fn format_image(mut arguments: impl Iterator<Item = OsString>) -> Result<(), Box<dyn Error>> {
    let geometry = next_geometry(&mut arguments)?;
    let paths = parse_exact_paths(arguments, 2, "format")?;
    let output = Output::new(&paths[1])?;
    let system_file = LockedFile::open(&paths[0])?;
    let system = system_file.read()?;
    let image = CpmImage::blank(geometry).migrate_to(geometry, &system)?;
    output.publish(&image.into_working_bytes(), &[&system_file])?;
    println!("Formatted {} as {}.", paths[1].display(), geometry.id());
    Ok(())
}

fn migrate_image(mut arguments: impl Iterator<Item = OsString>) -> Result<(), Box<dyn Error>> {
    let geometry = next_geometry(&mut arguments)?;
    let paths = parse_exact_paths(arguments, 3, "migrate")?;
    let output = Output::new(&paths[2])?;
    let (source_file, source) = load_image(&paths[0])?;
    let system_file = LockedFile::open(&paths[1])?;
    let system = system_file.read()?;
    let candidate = source.migrate_to(geometry, &system)?;
    output.publish(
        &candidate.into_working_bytes(),
        &[&source_file, &system_file],
    )?;
    println!(
        "Migrated {} to {} as {}; the source image is unchanged.",
        paths[0].display(),
        paths[2].display(),
        geometry.id(),
    );
    Ok(())
}

fn create(paths: Vec<PathBuf>) -> Result<(), Box<dyn Error>> {
    let output = Output::new(&paths[1])?;
    let (source_file, source) = load_image(&paths[0])?;
    let bytes = source.into_working_bytes();
    output.publish(&bytes, &[&source_file])?;
    println!(
        "Created {} from {} ({} bytes).",
        paths[1].display(),
        paths[0].display(),
        bytes.len()
    );
    Ok(())
}

fn list(paths: Vec<PathBuf>) -> Result<(), Box<dyn Error>> {
    let (_source_file, image) = load_image(&paths[0])?;
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
    let (image_file, image) = load_image(&image_path)?;
    let input_file = LockedFile::open(&mac_path)?;
    let contents = input_file.read()?;
    let replacement = image.install(&canonical, &contents)?;
    let stored = replacement
        .read(&canonical)?
        .ok_or("installed file was not found")?;
    Output::replace(&image_file).publish(replacement.as_bytes(), &[&input_file])?;
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
    let (image_file, image) = load_image(&image_path)?;
    let output = if force {
        Output::replace_or_new(&mac_path)?
    } else {
        Output::new(&mac_path)?
    };
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
    output.publish(bytes, &[&image_file])?;
    println!(
        "Exported {} to {} ({} bytes{}).",
        file.name,
        mac_path.display(),
        bytes.len(),
        if text { "; CP/M text EOF trimmed" } else { "" }
    );
    Ok(())
}

fn load_image(path: &Path) -> Result<(LockedFile, CpmImage), Box<dyn Error>> {
    let file = LockedFile::open(path)?;
    let image = CpmImage::from_bytes(file.read()?)?;
    Ok((file, image))
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
