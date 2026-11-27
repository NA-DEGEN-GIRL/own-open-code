// Windows identity of the shell that other files must repeat exactly (05 §4.6, §7.4): the AUMID (appId in
// electron-builder.config.ts, APP_ID in src/overrides/constants.ts) and the toast activator CLSIDs, which
// build/installer.nsh removes on uninstall. test/shell.test.ts checks that the copies agree.
// Not an rpcHash input (05 §5.5): nothing here crosses the shell ↔ renderer IPC.

export const AUMID = "dev.own.opencode.desktop"

/**
 * COM class Windows starts when a toast of the packaged shell is clicked in the Action Center after the app exited
 * (`app.setToastActivatorCLSID`). Electron registers it on the first toast as
 * `HKCU\Software\Classes\CLSID\{…}\LocalServer32` = the exe and puts it on the Start-menu shortcut it creates when
 * none carries the AUMID. Without a fixed id Electron picks a random one per run, so every run could leave another
 * key behind that no uninstaller knows about.
 */
export const TOAST_ACTIVATOR_CLSID = "{410CC5B4-2B31-47C3-BBEE-352837898B52}"

/** The unpackaged development shell (AUMID `dev.own.opencode.desktop.local`): its own class, never the installed one's. */
export const TOAST_ACTIVATOR_CLSID_LOCAL = "{735A737E-1B82-4E37-BD34-29DA1E5FF76D}"

/** electron-builder productName: the Start-menu shortcut "<name>.lnk" (the installer's, and the one Electron creates). */
export const PRODUCT_NAME = "Own OpenCode"
