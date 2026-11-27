//! Hybrid CRT for the MSVC target: link the VC runtime statically and the
//! Universal CRT dynamically. The UCRT ships with Windows 10+, while
//! VCRUNTIME140.dll only exists where a Visual C++ redistributable was
//! installed, so this keeps own-vault.exe self-contained without the full
//! `+crt-static` (which would need a .cargo/config.toml that
//! `cargo build --manifest-path` from the repo root does not pick up).

fn main() {
    println!("cargo:rerun-if-changed=build.rs");
    let msvc = std::env::var("CARGO_CFG_TARGET_ENV").is_ok_and(|env| env == "msvc");
    let crt_static = std::env::var("CARGO_CFG_TARGET_FEATURE")
        .is_ok_and(|features| features.split(',').any(|feature| feature == "crt-static"));
    if !msvc || crt_static {
        return;
    }
    for lib in [
        "libvcruntimed.lib",
        "vcruntime.lib",
        "vcruntimed.lib",
        "libcmtd.lib",
        "msvcrt.lib",
        "msvcrtd.lib",
        "libucrt.lib",
        "libucrtd.lib",
    ] {
        println!("cargo:rustc-link-arg=/NODEFAULTLIB:{lib}");
    }
    for lib in ["libcmt.lib", "libvcruntime.lib", "ucrt.lib"] {
        println!("cargo:rustc-link-arg=/DEFAULTLIB:{lib}");
    }
}
