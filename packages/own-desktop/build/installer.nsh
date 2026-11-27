; own-desktop NSIS include (05 §4.5, §7.4, §10.4; USER-GUIDE §2), set as nsis.include by electron-builder.config.ts.
; Upstream's include (packages/desktop/resources/windows/installer.nsh) is not included: since v2.2 it defines
; customInit (moves $INSTDIR to a folder named after the app id), customUnInstall, customCheckAppRunning and the
; updater's staged-package macros, which clash with these macros or do not apply to own (no updater, one channel).
; Its customInstall's icacls grant (what the Chromium sandbox needs) is repeated verbatim in this file's customInstall
; (test/shell.test.ts checks the two agree).
;
; One step for the user: the installer also installs, updates and removes the own-open-code service.
;   - Payload: when own/scripts/build-desktop.ps1 builds the installer it sets OWN_DESKTOP_PAYLOAD, electron-builder
;     packs <payload>\app and <payload>\bin into resources\own-payload, and OWN_PAYLOAD below is defined (read at
;     compile time). Without it (bun run package:win) this is a shell-only installer.
;   - customInit (before anything is extracted): the payload's launcher, `own.ps1 install --preflight`, says whether
;     this version would stop a service that runs sessions (exit 4, 05 §5.7). The user agrees, or the installer ends
;     with nothing changed. Silent (/S): refused (exit code 4) unless --own-force. Exit 5: the installer was started
;     inside a packaged app that virtualizes %LOCALAPPDATA% (e.g. the Claude desktop app's terminal or agents, MSIX
;     FileSystemWriteVirtualization): OWN_HOME would land in that app's private LocalCache, invisible to the Start-menu
;     app and to Explorer (2.0.18-own.2's "not installed" and "the hook never ran" reports). Told, ended, exit 5.
;   - customInstall: `own.ps1 install --from $INSTDIR\resources\own-payload --move --no-prompt [--force]` puts the
;     payload into OWN_HOME\app\<ver>, backs up opencode-own.db(-wal,-shm) to OWN_HOME\backup, writes the version
;     pointer OWN_HOME\app\current.json (an older launcher's app\current junction is removed, never followed) and points
;     the own plugin entries of opencode.jsonc at the new version, keeps the previous version (own rollback), copies
;     the launcher to OWN_HOME\bin, puts it on the user PATH, writes a missing config and restarts the service when it
;     was running (own.ps1 Invoke-Install). It runs last, after the shell's ~400 MB are extracted: a silent install
;     started from a shell returns to it at once (the installer is a GUI program), so the service part lands about a
;     minute later; wait for the installer (Start-Process -Wait) before looking at OWN_HOME.
;   - Log: every run of the launcher (command, PowerShell used, exit code or why it could not start) is appended to
;     %TEMP%\own-installer.log (UTF-16), and one ASCII line per run to OWN_HOME\install.log, next to the launcher's
;     own lines. Silent (/S): a failed or postponed service install ends the installer with the launcher's exit code
;     (1 failure, 4 sessions running, 64 usage) instead of 0.
;   - customUnInit (uninstall only, never when a newer installer runs this uninstaller to replace the files): asks
;     whether to remove the service too (default yes) and whether to delete the user data (default no); refuses while
;     sessions run unless the user agrees. Silent: service removed, data kept; --own-keep-service, --own-remove-data,
;     --own-force change that.
;   - customUnInstall: `own.ps1 uninstall [--remove-data]`, and with the data also the shell's %APPDATA% folder; then
;     the cleanup of what Electron and Windows register for toasts outside the install folder:
;       HKCU\Software\Classes\CLSID\{TOAST_ACTIVATOR_CLSID}: the COM toast activator Electron registers on the first
;       toast (LocalServer32 = own-desktop.exe), id fixed by src/shared/identity.ts (app.setToastActivatorCLSID);
;       the Start-menu shortcut "Own OpenCode.lnk" Electron creates when no shortcut carries the AUMID;
;       HKCU\...\Notifications\Settings\dev.own.opencode.desktop: Windows' per-app notification settings.
; Nothing is removed on an update: the new installer runs the old uninstaller as old-uninstaller.exe with /KEEP_APP_DATA
; and --updated. Only HKCU, the user's Start menu, %APPDATA% and the launcher's OWN_HOME are touched (per-user install).
!include LogicLib.nsh
!include FileFunc.nsh
!include x64.nsh

!define OWN_TOAST_ACTIVATOR_CLSID "{410CC5B4-2B31-47C3-BBEE-352837898B52}"
!define OWN_AUMID "dev.own.opencode.desktop"
!define OWN_SHORTCUT_NAME "Own OpenCode"
; electron-builder.config.ts PAYLOAD_RESOURCE
!define OWN_PAYLOAD_DIR "$INSTDIR\resources\own-payload"
!define OWN_PS_ARGS "-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File"

; $%NAME% is the environment at compile time; an unset variable stays literal, so the test is false.
!if /FileExists "$%OWN_DESKTOP_PAYLOAD%\bin\own.ps1"
  !define OWN_PAYLOAD "$%OWN_DESKTOP_PAYLOAD%"
!endif

!define OWN_MSG_SESSIONS_UPDATE "Own OpenCode 서비스에서 대화가 실행 중이에요.$\r$\n$\r$\n업데이트하려면 서비스를 멈춰야 해요. 진행 중인 턴은 중단되고 다음 시작 때 이어져요(프롬프트 캐시는 식어요).$\r$\n$\r$\n지금 서비스를 멈추고 업데이트할까요?$\r$\n[아니요]를 누르면 아무것도 바꾸지 않고 끝내요."
!define OWN_MSG_SESSIONS_LATE "설치하는 동안 Own OpenCode 서비스에서 대화가 시작됐어요.$\r$\n$\r$\n지금 서비스를 멈추고 서비스까지 업데이트할까요? 진행 중인 턴은 중단되고 다음 시작 때 이어져요.$\r$\n[아니요]를 누르면 데스크톱 앱만 새 버전이 되고 서비스는 이전 버전으로 남아요."
!define OWN_MSG_POSTPONED "서비스 업데이트를 미뤘어요. 데스크톱 앱과 서비스의 버전이 달라 앱이 '앱 셸과 화면 버전이 맞지 않아요'를 보일 수 있어요(그동안은 [브라우저로 열기]).$\r$\n$\r$\n대화가 끝난 뒤 이 설치 파일을 다시 실행하세요."
!define OWN_MSG_INSTALL_FAILED "Own OpenCode 서비스를 설치하지 못했어요(종료 코드 $R0). 데스크톱 앱은 설치됐고, 이전 버전의 서비스가 있었다면 그대로예요.$\r$\n$\r$\n자세한 내용: $R2\install.log, %TEMP%\own-installer.log"
!define OWN_MSG_VIRTUALIZED "이 설치 파일이 다른 앱(예: Claude 데스크톱 앱의 터미널이나 에이전트) 안에서 실행됐어요. 그 앱은 %LOCALAPPDATA%에 쓰는 파일을 자기 전용 폴더(%LOCALAPPDATA%\Packages\...\LocalCache)로 옮기므로, 여기서 설치하면 시작 메뉴의 Own OpenCode와 다른 프로그램이 서비스를 찾지 못해요.$\r$\n$\r$\n아무것도 바꾸지 않고 끝내요. 탐색기에서 설치 파일을 두 번 눌러 실행하세요.$\r$\n자세한 내용: %TEMP%\own-installer.log"
!define OWN_MSG_VIRTUALIZED_UNINSTALL "이 제거 프로그램이 다른 앱(예: Claude 데스크톱 앱의 터미널이나 에이전트) 안에서 실행됐어요. 그 앱은 %LOCALAPPDATA%의 파일을 자기 전용 사본으로 보므로, 여기서는 서비스를 제대로 제거할 수 없어요.$\r$\n$\r$\n아무것도 지우지 않고 끝내요. 설정 > 앱 또는 탐색기에서 다시 실행하세요."
!define OWN_MSG_REMOVE_SERVICE "Own OpenCode 서비스도 제거할까요?$\r$\n(opencode.exe와 설치된 버전들, own 명령, PATH 항목)$\r$\n$\r$\n계정·키·대화 기록 같은 사용자 데이터는 다음 질문에서 따로 물어요.$\r$\n[아니요]를 누르면 데스크톱 앱만 제거해요."
!define OWN_MSG_REMOVE_DATA "사용자 데이터도 삭제할까요? 되돌릴 수 없어요.$\r$\n$\r$\n계정 레지스트리, vault(키·토큰), 사용량 기록, 대화 DB, 설정, DB 백업, 데스크톱 앱 데이터가 지워져요.$\r$\n$\r$\n[아니요](기본)를 누르면 데이터는 남고, 다시 설치하면 그대로 쓰여요."
!define OWN_MSG_SESSIONS_UNINSTALL "Own OpenCode 서비스에서 대화가 실행 중이에요.$\r$\n$\r$\n서비스를 멈추고 제거할까요? 진행 중인 턴은 중단돼요.$\r$\n[아니요]를 누르면 아무것도 제거하지 않고 끝내요."
!define OWN_MSG_SESSIONS_UNINSTALL_LATE "제거하는 동안 서비스에서 대화가 시작됐어요.$\r$\n$\r$\n서비스를 멈추고 계속 제거할까요?$\r$\n[아니요]를 누르면 서비스는 남기고 데스크톱 앱만 제거해요."
!define OWN_MSG_UNINSTALL_KEPT "서비스는 남겨 뒀어요. 대화가 끝난 뒤 PowerShell에서 'own uninstall'을 실행하세요."
!define OWN_MSG_UNINSTALL_FAILED "Own OpenCode 서비스의 일부를 지우지 못했어요(종료 코드 $R0).$\r$\n$\r$\n나중에 PowerShell에서 'own uninstall'을 다시 실행하거나 남은 파일을 직접 지우세요. 자세한 내용: $R2\install.log"

; 64-bit Windows PowerShell even from this 32-bit installer (Sysnative), the same one own.cmd runs.
!macro ownPowerShell VAR
  StrCpy ${VAR} "$WINDIR\Sysnative\WindowsPowerShell\v1.0\powershell.exe"
  ${IfNot} ${FileExists} "${VAR}"
    StrCpy ${VAR} "$SYSDIR\WindowsPowerShell\v1.0\powershell.exe"
  ${EndIf}
!macroend

; ---------------------------------------------------------------- log
; %TEMP%\own-installer.log: UTF-16LE (NSIS writes no UTF-8), so paths with any characters survive. A macro, not a
; function: the same text serves the installer, the uninstaller and the test harness (tests/install.test.mjs), and
; electron-builder compiles with warnings as errors (an unreferenced function fails the build).
!define OWN_INSTALLER_LOG "$TEMP\own-installer.log"

; Appends "<yyyy-mm-dd hh:mm:ss> TEXT". TEXT is evaluated first, so it may name any register; all are kept.
!macro ownLog TEXT
  Push $7
  StrCpy $7 `${TEXT}`
  Push $0
  Push $1
  Push $2
  Push $3
  Push $4
  Push $5
  Push $6
  ${GetTime} "" "L" $0 $1 $2 $3 $4 $5 $6
  ClearErrors
  ${If} ${FileExists} "${OWN_INSTALLER_LOG}"
    FileOpen $3 "${OWN_INSTALLER_LOG}" a
  ${Else}
    FileOpen $3 "${OWN_INSTALLER_LOG}" w
    ${IfNot} ${Errors}
      FileWriteWord $3 0xFEFF
    ${EndIf}
  ${EndIf}
  ${IfNot} ${Errors}
    FileSeek $3 0 END
    FileWriteUTF16LE $3 "$2-$1-$0 $4:$5:$6 $7$\r$\n"
    FileClose $3
  ${EndIf}
  Pop $6
  Pop $5
  Pop $4
  Pop $3
  Pop $2
  Pop $1
  Pop $0
  Pop $7
!macroend

; One ASCII line (no paths) in OWN_HOME\install.log, which the launcher writes in UTF-8: the installer's side of a run
; next to the launcher's. Only when OWN_HOME exists (an uninstall with --remove-data has removed it).
!macro ownHomeLog HOME TEXT
  Push $7
  StrCpy $7 `${TEXT}`
  Push $0
  Push $1
  Push $2
  Push $3
  Push $4
  Push $5
  Push $6
  ${If} ${FileExists} "${HOME}\*.*"
    ${GetTime} "" "L" $0 $1 $2 $3 $4 $5 $6
    ClearErrors
    FileOpen $3 "${HOME}\install.log" a
    ${IfNot} ${Errors}
      FileSeek $3 0 END
      FileWrite $3 "$2-$1-$0 $4:$5:$6 $7$\r$\n"
      FileClose $3
    ${EndIf}
  ${EndIf}
  Pop $6
  Pop $5
  Pop $4
  Pop $3
  Pop $2
  Pop $1
  Pop $0
  Pop $7
!macroend

; OWN_HOME as own.ps1 and the shell compute it.
!macro ownHome VAR
  ReadEnvStr ${VAR} OWN_HOME
  ${If} ${VAR} == ""
    StrCpy ${VAR} "$LOCALAPPDATA\own-open-code"
  ${EndIf}
!macroend

; ---------------------------------------------------------------- install

!ifdef OWN_PAYLOAD
!ifndef BUILD_UNINSTALLER
!macro customInit
  Var /GLOBAL ownPowerShell
  Var /GLOBAL ownForce
  !insertmacro ownPowerShell $ownPowerShell
  StrCpy $ownForce ""
  ${GetParameters} $R0
  ClearErrors
  ${GetOptions} $R0 "--own-force" $R1
  ${IfNot} ${Errors}
    StrCpy $ownForce "--force"
  ${EndIf}
  !insertmacro ownLog "==== installer ${VERSION} (own-desktop, $EXEFILE $R0)"
  ${IfNot} ${FileExists} "$ownPowerShell"
    !insertmacro ownLog "PowerShell not found at $ownPowerShell (nor $WINDIR\Sysnative\...): the service part cannot run"
  ${EndIf}
  ; Only the payload's launcher is needed (the payload itself is extracted later).
  InitPluginsDir
  File "/oname=$PLUGINSDIR\own-preflight.ps1" "${OWN_PAYLOAD}\bin\own.ps1"
  !insertmacro ownLog 'preflight: "$ownPowerShell" ${OWN_PS_ARGS} "$PLUGINSDIR\own-preflight.ps1" install --preflight --version "${VERSION}"'
  nsExec::Exec '"$ownPowerShell" ${OWN_PS_ARGS} "$PLUGINSDIR\own-preflight.ps1" install --preflight --version "${VERSION}"'
  Pop $R0
  ; "error": nsExec could not start the process; "timeout" does not happen (no /TIMEOUT).
  !insertmacro ownLog "preflight: exit $R0"
  ; 5: this installer runs inside a packaged app that virtualizes %LOCALAPPDATA% (own.ps1 Assert-NotVirtualized): the
  ; service would be installed into that app's private copy only. Nothing is extracted yet; nothing changes.
  ${If} $R0 == 5
    MessageBox MB_OK|MB_ICONSTOP "${OWN_MSG_VIRTUALIZED}" /SD IDOK
    !insertmacro ownLog "refused: %LOCALAPPDATA% is virtualized for this process (packaged app); nothing changed, exit 5"
    SetErrorLevel 5
    Quit
  ${EndIf}
  ${If} $R0 == 4
  ${AndIf} $ownForce == ""
    MessageBox MB_YESNO|MB_ICONEXCLAMATION|MB_DEFBUTTON2 "${OWN_MSG_SESSIONS_UPDATE}" /SD IDNO IDYES own_preflight_agreed
    !insertmacro ownLog "sessions are running and the update was declined (silent: no --own-force): nothing changed, exit 4"
    SetErrorLevel 4
    Quit
    own_preflight_agreed:
    StrCpy $ownForce "--force"
  ${EndIf}
!macroend

!macro ownInstallService
  Var /GLOBAL ownServiceExit
  StrCpy $ownServiceExit 0
  !insertmacro ownHome $R2
  ${If} ${FileExists} "${OWN_PAYLOAD_DIR}\bin\own.ps1"
    StrCpy $R1 $ownForce
    ${Do}
      !insertmacro ownLog 'install: "$ownPowerShell" ${OWN_PS_ARGS} "${OWN_PAYLOAD_DIR}\bin\own.ps1" install --from "${OWN_PAYLOAD_DIR}" --move --no-prompt $R1 (OWN_HOME $R2)'
      nsExec::ExecToLog '"$ownPowerShell" ${OWN_PS_ARGS} "${OWN_PAYLOAD_DIR}\bin\own.ps1" install --from "${OWN_PAYLOAD_DIR}" --move --no-prompt $R1'
      Pop $R0
      !insertmacro ownLog "install: exit $R0"
      !insertmacro ownHomeLog $R2 "installer ${VERSION}: own.ps1 install exited $R0 (details: %TEMP%\own-installer.log)"
      ${If} $R0 != 4
      ${OrIf} $R1 == "--force"
        ${Break}
      ${EndIf}
      ; Sessions started after the first question, while the files were extracted.
      MessageBox MB_YESNO|MB_ICONEXCLAMATION|MB_DEFBUTTON2 "${OWN_MSG_SESSIONS_LATE}" /SD IDNO IDYES own_install_agreed
      ${Break}
      own_install_agreed:
      StrCpy $R1 "--force"
    ${Loop}
    ${If} $R0 == 4
      MessageBox MB_OK|MB_ICONINFORMATION "${OWN_MSG_POSTPONED}" /SD IDOK
      StrCpy $ownServiceExit 4
    ${ElseIf} $R0 == 5
      MessageBox MB_OK|MB_ICONSTOP "${OWN_MSG_VIRTUALIZED}" /SD IDOK
      StrCpy $ownServiceExit 5
    ${ElseIf} $R0 == "error"
      ; nsExec could not start PowerShell at all.
      StrCpy $R0 "error: PowerShell did not start"
      MessageBox MB_OK|MB_ICONSTOP "${OWN_MSG_INSTALL_FAILED}" /SD IDOK
      StrCpy $ownServiceExit 1
    ${ElseIf} $R0 != 0
      MessageBox MB_OK|MB_ICONSTOP "${OWN_MSG_INSTALL_FAILED}" /SD IDOK
      StrCpy $ownServiceExit $R0
    ${EndIf}
  ${Else}
    ; The payload was packed (OWN_PAYLOAD) but is not where the shell's files were extracted.
    !insertmacro ownLog "install: ${OWN_PAYLOAD_DIR}\bin\own.ps1 is missing after the extraction; the service part did not run"
    !insertmacro ownHomeLog $R2 "installer ${VERSION}: the payload was missing after the extraction; the service part did not run"
    StrCpy $ownServiceExit 1
  ${EndIf}
!macroend

; Silent installs report the service part in their exit code (the MessageBoxes above are skipped with /S). Last in
; customInstall: electron-builder's quitSuccess would set 0 right after it.
!macro ownSilentExit
  ${If} ${Silent}
  ${AndIf} $ownServiceExit != 0
    !insertmacro ownLog "silent install ends with exit $ownServiceExit (the shell is installed; see above)"
    SetErrorLevel $ownServiceExit
    Quit
  ${EndIf}
!macroend
!endif
!endif

!macro customInstall
  !ifdef OWN_PAYLOAD
    !ifndef BUILD_UNINSTALLER
      ; First, so the payload is moved out of $INSTDIR before the grant below walks the folder.
      !insertmacro ownInstallService
    !endif
  !endif
  ; ---- upstream packages/desktop/resources/windows/installer.nsh customInstall, verbatim
  ; Chromium's sandbox needs read/execute access to the installed runtime files.
  ; https://github.com/electron/electron/issues/49143#issuecomment-3618354787
  nsExec::ExecToLog '"$SYSDIR\icacls.exe" "$INSTDIR" /grant "*S-1-15-2-2:(OI)(CI)(RX)"'
  Pop $0
  ; ---- end of upstream
  ; No updater (publish: null): electron-builder's copy of this installer for differential updates is dead weight.
  !ifdef APP_INSTALLER_STORE_FILE
    Delete "$LOCALAPPDATA\${APP_INSTALLER_STORE_FILE}"
    ${GetParent} "$LOCALAPPDATA\${APP_INSTALLER_STORE_FILE}" $R0
    RMDir $R0
  !endif
  !ifdef OWN_PAYLOAD
    !ifndef BUILD_UNINSTALLER
      !insertmacro ownSilentExit
    !endif
  !endif
!macroend

; ---------------------------------------------------------------- uninstall

!macro customUnInit
  Var /GLOBAL ownUnService
  Var /GLOBAL ownUnData
  Var /GLOBAL ownUnForce
  Var /GLOBAL ownUnPowerShell
  Var /GLOBAL ownUnLauncher
  Var /GLOBAL ownUnHome
  StrCpy $ownUnService "0"
  StrCpy $ownUnData ""
  StrCpy $ownUnForce ""
  StrCpy $ownUnLauncher ""
  !insertmacro ownPowerShell $ownUnPowerShell
  !insertmacro ownHome $ownUnHome
  ${GetParameters} $R0
  ; Not when a newer installer runs this uninstaller to replace the files: it copies it to old-uninstaller.exe and
  ; passes /KEEP_APP_DATA and --updated (app-builder-lib installUtil.nsh uninstallOldVersion).
  ClearErrors
  ${GetOptions} $R0 "/KEEP_APP_DATA" $R1
  ${If} ${Errors}
  ${AndIfNot} ${isUpdated}
  ${AndIf} $EXEFILE != "old-uninstaller.exe"
    ${If} ${FileExists} "$ownUnHome\bin\own.ps1"
      StrCpy $ownUnLauncher "$ownUnHome\bin\own.ps1"
    ${ElseIf} ${FileExists} "${OWN_PAYLOAD_DIR}\bin\own.ps1"
      StrCpy $ownUnLauncher "${OWN_PAYLOAD_DIR}\bin\own.ps1"
    ${EndIf}
  ${EndIf}
  ${If} $ownUnLauncher != ""
    ClearErrors
    ${GetOptions} $R0 "/S" $R1
    ${If} ${Errors}
      ; Interactive. The oneClick uninstaller has turned itself silent after its own question, and a MessageBox
      ; without /SD still shows then.
      MessageBox MB_YESNO|MB_ICONQUESTION "${OWN_MSG_REMOVE_SERVICE}" IDNO own_uninstall_asked
      StrCpy $ownUnService "1"
      MessageBox MB_YESNO|MB_ICONEXCLAMATION|MB_DEFBUTTON2 "${OWN_MSG_REMOVE_DATA}" IDNO own_uninstall_asked
      StrCpy $ownUnData "--remove-data"
      own_uninstall_asked:
    ${Else}
      StrCpy $ownUnService "1"
      ClearErrors
      ${GetOptions} $R0 "--own-keep-service" $R1
      ${IfNot} ${Errors}
        StrCpy $ownUnService "0"
      ${EndIf}
      ClearErrors
      ${GetOptions} $R0 "--own-remove-data" $R1
      ${IfNot} ${Errors}
        StrCpy $ownUnData "--remove-data"
      ${EndIf}
      ClearErrors
      ${GetOptions} $R0 "--own-force" $R1
      ${IfNot} ${Errors}
        StrCpy $ownUnForce "--force"
      ${EndIf}
    ${EndIf}
  ${EndIf}
  ${If} $ownUnLauncher != ""
    !insertmacro ownLog "==== uninstaller ($EXEFILE $R0): remove service=$ownUnService data=$ownUnData force=$ownUnForce launcher=$ownUnLauncher"
  ${EndIf}
  ; Running sessions: asked before anything is removed (exit 4, 05 §5.7); "no" ends the uninstaller.
  ${If} $ownUnService == "1"
  ${AndIf} $ownUnForce == ""
    nsExec::Exec '"$ownUnPowerShell" ${OWN_PS_ARGS} "$ownUnLauncher" uninstall --check'
    Pop $R1
    !insertmacro ownLog "uninstall --check: exit $R1"
    ; 5: started inside a packaged app that virtualizes %LOCALAPPDATA%; the service would be removed only from that
    ; app's private copy (and the PATH entry from the real one). Told, nothing removed.
    ${If} $R1 == 5
      MessageBox MB_OK|MB_ICONSTOP "${OWN_MSG_VIRTUALIZED_UNINSTALL}" /SD IDOK
      SetErrorLevel 5
      Quit
    ${EndIf}
    ${If} $R1 == 4
      MessageBox MB_YESNO|MB_ICONEXCLAMATION|MB_DEFBUTTON2 "${OWN_MSG_SESSIONS_UNINSTALL}" /SD IDNO IDYES own_uninstall_agreed
      SetErrorLevel 4
      Quit
      own_uninstall_agreed:
      StrCpy $ownUnForce "--force"
    ${EndIf}
  ${EndIf}
!macroend

!macro customUnInstall
  ${ifNot} ${isUpdated}
    ${If} $ownUnService == "1"
      StrCpy $R2 $ownUnHome
      StrCpy $R1 $ownUnForce
      ${Do}
        !insertmacro ownLog 'uninstall: "$ownUnPowerShell" ${OWN_PS_ARGS} "$ownUnLauncher" uninstall --no-prompt $ownUnData $R1'
        nsExec::ExecToLog '"$ownUnPowerShell" ${OWN_PS_ARGS} "$ownUnLauncher" uninstall --no-prompt $ownUnData $R1'
        Pop $R0
        !insertmacro ownLog "uninstall: exit $R0"
        !insertmacro ownHomeLog $R2 "uninstaller: own.ps1 uninstall exited $R0 (details: %TEMP%\own-installer.log)"
        ${If} $R0 != 4
        ${OrIf} $R1 == "--force"
          ${Break}
        ${EndIf}
        MessageBox MB_YESNO|MB_ICONEXCLAMATION|MB_DEFBUTTON2 "${OWN_MSG_SESSIONS_UNINSTALL_LATE}" /SD IDNO IDYES own_uninstall_late_agreed
        ${Break}
        own_uninstall_late_agreed:
        StrCpy $R1 "--force"
      ${Loop}
      ${If} $R0 == 4
        MessageBox MB_OK|MB_ICONINFORMATION "${OWN_MSG_UNINSTALL_KEPT}" /SD IDOK
      ${ElseIf} $R0 != 0
        MessageBox MB_OK|MB_ICONEXCLAMATION "${OWN_MSG_UNINSTALL_FAILED}" /SD IDOK
      ${EndIf}
      ${If} $ownUnData != ""
        ; The shell's userData (window state, session list cache, drafts, logs) goes with the user data.
        RMDir /r "$APPDATA\${OWN_AUMID}"
      ${EndIf}
    ${EndIf}
    DeleteRegKey HKCU "Software\Classes\CLSID\${OWN_TOAST_ACTIVATOR_CLSID}"
    DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Notifications\Settings\${OWN_AUMID}"
    ; Per-user install: $SMPROGRAMS is the user's Start menu (electron-builder sets the shell context first).
    ${if} ${FileExists} "$SMPROGRAMS\${OWN_SHORTCUT_NAME}.lnk"
      WinShell::UninstShortcut "$SMPROGRAMS\${OWN_SHORTCUT_NAME}.lnk"
      Delete "$SMPROGRAMS\${OWN_SHORTCUT_NAME}.lnk"
    ${endIf}
  ${endIf}
!macroend
