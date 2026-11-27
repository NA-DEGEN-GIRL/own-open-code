use std::ffi::OsString;
use std::io;
use std::path::PathBuf;
use std::process::ExitCode;

use own_vault::protocol::serve;
use own_vault::vault::Vault;
use own_vault::{NAME, PROTOCOL, VERSION};

const USAGE: &str = "\
usage: own-vault --home <OWN_HOME> | --vault-dir <DIR>

Serves JSON-line requests on stdin, one response line per request on stdout,
and exits 0 when stdin reaches EOF. The vault directory is <OWN_HOME>\\vault;
without flags, OWN_HOME from the environment is used. Paths must be absolute.
Secrets are never accepted as arguments or environment variables.";

fn usage_error(message: &str) -> ExitCode {
    eprintln!("{NAME}: {message}\n\n{USAGE}");
    ExitCode::from(2)
}

fn main() -> ExitCode {
    let mut args = std::env::args_os().skip(1);
    let mut dir: Option<PathBuf> = None;
    while let Some(arg) = args.next() {
        let mut value = |flag: &str| args.next().ok_or_else(|| format!("{flag} needs a value"));
        let parsed = match arg.to_str() {
            Some("--version" | "-V") => {
                println!("{NAME} {VERSION} (protocol {PROTOCOL})");
                return ExitCode::SUCCESS;
            }
            Some("--help" | "-h") => {
                println!("{USAGE}");
                return ExitCode::SUCCESS;
            }
            Some("--home") => value("--home").map(|home| PathBuf::from(home).join("vault")),
            Some("--vault-dir") => value("--vault-dir").map(PathBuf::from),
            _ => Err(format!("unknown argument {arg:?}")),
        };
        match parsed {
            Ok(path) => dir = Some(path),
            Err(message) => return usage_error(&message),
        }
    }
    let dir = dir.or_else(|| {
        std::env::var_os("OWN_HOME")
            .filter(|home: &OsString| !home.is_empty())
            .map(|home| PathBuf::from(home).join("vault"))
    });
    let Some(dir) = dir else {
        return usage_error("vault location missing");
    };
    if !dir.is_absolute() {
        return usage_error("vault location must be an absolute path");
    }
    let vault = match Vault::open(&dir) {
        Ok(vault) => vault,
        Err(error) => {
            eprintln!("{NAME}: cannot open vault directory: {error}");
            return ExitCode::from(1);
        }
    };
    match serve(&vault, io::stdin().lock(), io::stdout().lock()) {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("{NAME}: stdio failed: {error}");
            ExitCode::from(1)
        }
    }
}
