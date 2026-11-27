# own-vault third-party crates

Generated from `cargo metadata --locked --filter-platform x86_64-pc-windows-msvc` for `own-vault 0.1.0`
(FORK.md §10). Regenerate after changing `Cargo.lock` (for example with `cargo about`).

"Build-time only" crates run inside the compiler (proc macros) and are not linked into `own-vault.exe`.

| Crate | Version | License | Linked into the binary | Repository |
|---|---|---|---|---|
| itoa | 1.0.18 | MIT OR Apache-2.0 | yes | https://github.com/dtolnay/itoa |
| memchr | 2.8.3 | Unlicense OR MIT | yes | https://github.com/BurntSushi/memchr |
| proc-macro2 | 1.0.107 | MIT OR Apache-2.0 | build-time only | https://github.com/dtolnay/proc-macro2 |
| quote | 1.0.47 | MIT OR Apache-2.0 | build-time only | https://github.com/dtolnay/quote |
| serde | 1.0.229 | MIT OR Apache-2.0 | yes | https://github.com/serde-rs/serde |
| serde_core | 1.0.229 | MIT OR Apache-2.0 | yes | https://github.com/serde-rs/serde |
| serde_derive | 1.0.229 | MIT OR Apache-2.0 | build-time only | https://github.com/serde-rs/serde |
| serde_json | 1.0.151 | MIT OR Apache-2.0 | yes | https://github.com/serde-rs/json |
| syn | 2.0.119 | MIT OR Apache-2.0 | build-time only | https://github.com/dtolnay/syn |
| syn | 3.0.6 | MIT OR Apache-2.0 | build-time only | https://github.com/dtolnay/syn |
| unicode-ident | 1.0.26 | (MIT OR Apache-2.0) AND Unicode-3.0 | build-time only | https://github.com/dtolnay/unicode-ident |
| windows | 0.62.2 | MIT OR Apache-2.0 | yes | https://github.com/microsoft/windows-rs |
| windows-collections | 0.3.2 | MIT OR Apache-2.0 | yes | https://github.com/microsoft/windows-rs |
| windows-core | 0.62.2 | MIT OR Apache-2.0 | yes | https://github.com/microsoft/windows-rs |
| windows-future | 0.3.2 | MIT OR Apache-2.0 | yes | https://github.com/microsoft/windows-rs |
| windows-implement | 0.60.2 | MIT OR Apache-2.0 | build-time only | https://github.com/microsoft/windows-rs |
| windows-interface | 0.59.3 | MIT OR Apache-2.0 | build-time only | https://github.com/microsoft/windows-rs |
| windows-link | 0.2.1 | MIT OR Apache-2.0 | yes | https://github.com/microsoft/windows-rs |
| windows-numerics | 0.3.1 | MIT OR Apache-2.0 | yes | https://github.com/microsoft/windows-rs |
| windows-result | 0.4.1 | MIT OR Apache-2.0 | yes | https://github.com/microsoft/windows-rs |
| windows-strings | 0.5.1 | MIT OR Apache-2.0 | yes | https://github.com/microsoft/windows-rs |
| windows-threading | 0.2.1 | MIT OR Apache-2.0 | yes | https://github.com/microsoft/windows-rs |
| zmij | 1.0.23 | MIT | yes | https://github.com/dtolnay/zmij |

The Microsoft C runtime is linked as a hybrid CRT (`build.rs`): the VC runtime is static (part of the
MSVC toolchain, redistributable under the Visual Studio license terms) and the Universal CRT is the
Windows system component (`api-ms-win-crt-*`).
