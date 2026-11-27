// 원격 PC 전용 빌드 (own/reports/win-arm64-2026-11-06.md): a shell built with OWN_DESKTOP_CLIENT_ONLY=1
// (own/scripts/build-desktop-client.ps1, the Windows ARM64 installer) has no local service. It never discovers or
// starts one (service/background-service-own.ts), always shows the remote-client page (src/client, built as its
// renderer instead of the fallback page) and quits as a plain app (quit.ts). Other PCs open in their pinned windows
// exactly as in the full shell (remote-pcs/service.ts). A build constant, not a runtime switch: the x64 release
// behaves as before whatever the environment says.
export const clientOnly = import.meta.env.OWN_CLIENT_ONLY === "1"
