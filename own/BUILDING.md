**English** | [한국어](BUILDING.ko.md)

# Building own-open-code

No installers are published, so you build the app yourself. Everything is built on one Windows 11 x64 PC: the desktop app and its service, the bundles for Linux servers, the Windows ARM64 client and the Android app. macOS and Linux are not supported as build machines.

The first build takes 10 to 25 minutes and about 10 GB of disk space, plus the tools below.

## What you need

| Tool | Version | For |
|---|---|---|
| Windows | 11, x64 | everything |
| Git for Windows | a recent one | cloning; the build reads the commit |
| Bun | exactly the one in `packageManager` of `package.json` (**1.4.4** now) | everything; the scripts stop on another version |
| Node.js | 22, with npm | the desktop app |
| Rust | stable 1.85 or newer, `x86_64-pc-windows-msvc` | the key store helper (`own-vault`) |
| MSVC build tools | Visual Studio Build Tools, workload *Desktop development with C++* | linking the Rust helper |
| 7-Zip | any, optional | an extra check of the installer's contents |
| JDK | 17 or newer (tested with 21) | the Android app only |
| Android SDK | `platforms;android-36`, `build-tools;37.0.0` | the Android app only |

Windows PowerShell 5.1, which the scripts run in, and the .NET Framework compiler for the computer-use helper are part of Windows. The commands below work in PowerShell 5.1 and 7.

```powershell
winget install Git.Git OpenJS.NodeJS.22 Rustlang.Rustup
winget install Microsoft.VisualStudio.2022.BuildTools --override "--add Microsoft.VisualStudio.Workload.VCTools --includeRecommended --passive"
npm install -g bun@1.4.4
```

Open a new terminal afterwards and check `git --version`, `node --version`, `bun --version` and `cargo --version`.

## Get the source

Use a **short path without `#`** (Bun and Vite break on `#`, and the scripts refuse it). Some files have long names, so let Git use long paths:

```powershell
git clone -c core.longpaths=true https://github.com/NA-DEGEN-GIRL/own-open-code.git C:\src\own-open-code
cd C:\src\own-open-code
bun install --frozen-lockfile
```

Clone it, do not download a ZIP: the build records the commit it was made from. Bun says that it skipped packages of other platforms and blocked some install scripts; both are fine.

**Line endings** need no setting: the repository's `.gitattributes` keeps every file as it is stored, whatever `core.autocrlf` says (Git for Windows defaults to `true`, which used to break tests that compare source text).

**Symbolic links.** The tree has 29 of them (icons and one type file). Without Windows Developer Mode, Git writes each as a small text file holding the target's path. Either turn Developer Mode on and clone with `-c core.symlinks=true` as well, or, after a normal clone, run once:

```powershell
node own/scripts/link-copies.mjs
```

It copies each link's target over the text file and tells Git to leave the copy alone (`--skip-worktree`). Run it again after a pull that changes a link.

## Desktop app

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File own\scripts\build-desktop.ps1
```

This builds the command line and service (`opencode.exe`), the plugins, the web interface, the key store helper, the Electron shell and one installer. Nothing is installed or started, apart from a short check of the fresh `opencode.exe` in a temporary folder.

| Option | What it does |
|---|---|
| `-Version 2.4.0-own.1` | the version, `<root package.json version>-own.<number>`. Default: `…-own.0`. Raise the number for an update of your own installation |
| `-Remote` | also the bundles for Linux servers (see below) |
| `-Client` | also the Windows ARM64 client (see below) |
| `-NoInstaller` | only the unpacked app |
| `-SkipService` | reuse the `opencode.exe` of the last run with the same version |

Output, in `own\.out\build\<version>\`:

| Path | What it is |
|---|---|
| `desktop\own-desktop-<version>-win-x64.exe` | the installer: app, service and the `own` command |
| `desktop\win-unpacked\` | the unpacked desktop shell |
| `cli-windows-x64\bin\opencode.exe` | the command line and service |
| `app\`, `bin\` | the layout that gets installed |
| `manifest.json`, `desktop-build.json` | versions, hashes, sizes and the checks that ran |

### Install, update, remove

Start the installer **from Explorer** or from a terminal you opened from the Start menu. It installs for the current user without administrator rights. Do not start it from a terminal inside a packaged desktop app, such as an agent's: Windows then redirects the files into that app's private folder. The installer notices this and stops.

Update by running a newer installer. `own rollback` in a terminal goes back one version. Remove the app in *Settings → Apps*; your data stays until you delete it (`own uninstall --remove-data` removes both).

| Where | What |
|---|---|
| `%LOCALAPPDATA%\Programs\own-desktop` | the desktop app |
| `%LOCALAPPDATA%\own-open-code` | the service, accounts, the encrypted key store, logs |
| `%USERPROFILE%\.local\share\opencode\opencode-own.db` | conversations |
| `%USERPROFILE%\.config\own-open-code` | settings |

### Command line and service only

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File own\scripts\build-own.ps1
```

This removes the output folder of the same version first, so run it before the other scripts.

## Bundles for Linux servers

You need these to use SSH hosts. They are cross-compiled on Windows and sit inside the installer:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File own\scripts\build-desktop.ps1 -Remote
```

Output: `remote\linux-x64-baseline.tar.gz`, `remote\linux-arm64.tar.gz` and the Git LFS binaries in `remote\tools`. The script downloads the Linux native packages pinned in `bun.lock`, Bun's Linux runtimes and the pinned Git LFS release, and checks all of them against their hashes.

## Windows ARM64 client

A desktop app that connects to another PC that runs own; it has no service of its own.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File own\scripts\build-desktop-client.ps1
```

Output: `desktop-client-arm64\own-desktop-client-<version>-win-arm64.exe`. It downloads Electron, node-pty and ffi-rs for ARM64 and checks their hashes. The result passes its static checks but has not been run on an ARM64 PC yet. Run this after `build-desktop.ps1`, or use that script's `-Client`.

## Android app

Point `JAVA_HOME` at a JDK (or put one in `%LOCALAPPDATA%\Programs\jdk-21`) and `ANDROID_HOME` at the SDK (default `%LOCALAPPDATA%\Android\Sdk`). With Android's command line tools:

```powershell
sdkmanager "platforms;android-36" "build-tools;37.0.0"
powershell -NoProfile -ExecutionPolicy Bypass -File own\scripts\build-android.ps1
```

Output: `android\own-opencode-<version>.apk`. Run it after the desktop build, which clears the output folder of the same version.

**Your signing key.** The APK is signed with the debug key of your PC. Gradle creates it on the first build in `%USERPROFILE%\.android\debug.keystore` (`ANDROID_USER_HOME` moves it). Back that file up: Android installs an update only when it carries the same key, and the version must be higher than the installed one. Copy the APK to the phone, or use `adb install`.

## Development run

Both start a development service with fake providers in a temporary folder, so you need no account and your installation is not touched:

```powershell
bun run --cwd packages/own-web dev:service        # the web interface at http://localhost:5173
bun run --cwd packages/own-desktop electron:install
bun run --cwd packages/own-desktop dev            # the desktop shell
```

Checks: `bun run check` in the root (lint and types), and `bun typecheck` and `bun run test` inside a package. Never run tests from the root. The slow suites take a lock in `C:\t\locks` so that only one runs at a time; `OWN_HEAVY_LOCK` moves it. The pictures of the README come from `bun own/scripts/readme/capture.ts`.

## What gets downloaded

| When | From | What |
|---|---|---|
| `bun install` | npm | the packages in `bun.lock` |
| desktop build | crates.io | the crates in `own/native/own-vault/Cargo.lock` |
| desktop build | npm | `opencode-claude-auth-v2`, pinned by integrity |
| desktop build | GitHub | Electron (about 150 MB) and electron-builder's NSIS and signing tools |
| `-Remote` | npm, GitHub | Linux native packages, Bun runtimes, Git LFS |
| ARM64 client | npm, GitHub | Electron, node-pty and ffi-rs for ARM64 |
| Android | Gradle, Google, Maven Central | Gradle and the app's libraries |

All of it is kept in the tools' own caches or in `own\.out` and reused. With `-Remote` the script also compares Bun's Linux runtimes with npm and GitHub; `build-remote.ps1 -SkipRuntimeCheck` leaves that out.

## Common problems

### Windows blocks the built files

The files are not signed. SmartScreen may show a warning for a file that came from another PC. **Smart App Control** can block an unsigned program entirely: the build stops with `spawn UNKNOWN` or *An Application Control policy has blocked this file*, or the installed app does not start. Nothing in this project works around that, and you should not switch the protection off for this app. What is left is a PC where Smart App Control is off already, or signing the files with a certificate Windows trusts. For signing, run `build-own.ps1`, sign `opencode.exe`, then run `build-desktop.ps1 -SkipService`, because the build records the file's hash.

### `contains '#'`

Move the checkout to a path without `#`.

### `Filename too long`

Clone into a shorter path with `-c core.longpaths=true`.

### `bun … does not match packageManager`

Install the version the message names: `npm install -g bun@<version>`.

### `link.exe not found` or other Rust errors

The C++ workload of the Visual Studio Build Tools is missing. Install it and open a new terminal.

### `bun run check` fails in `custom-elements.d.ts`

Git for Windows wrote OpenCode's symbolic links as text files, and one of them is a type file. Run `node own/scripts/link-copies.mjs` (see [Get the source](#get-the-source)).

### A test uses the wrong `bash`

`C:\Windows\System32\bash.exe` is WSL. The builds do not use bash, but the SSH tests need the one of Git for Windows: run them from Git Bash.

### `own-vault.exe` or `opencode.exe` is in use

The development run of another checkout may hold it. Close it, or build with another `-Version`.

### The APK does not install over the old one

It was signed on another PC, or its version is not higher. Copy the old `debug.keystore`, raise the number after `-own.`, or uninstall the app first (the phone then has to be paired again).

### Electron or NSIS cannot be downloaded

`build-desktop.ps1 -ElectronCache <folder>` takes a folder with `electron-v<version>-win32-x64.zip`. For the rest, set `HTTPS_PROXY` when you are behind a proxy.
