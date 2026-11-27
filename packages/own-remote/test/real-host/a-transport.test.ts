// Real-host phase A (04 §20.3 RG2–RG5, RG10 key part, RG16 bind): own-remote's controller and operations in this
// process with the REAL ssh.exe (temp config and known_hosts, see env.ts), the release bundle of this PC and the
// broker test double of the fake-SSH harness (the full broker is phase B). Opt-in: OWN_REAL_HOST=dev-host.
//
// Everything this suite starts on the host is ours (the own-channel service, `sleep`/`python3` stand-ins for a reused
// pid and a busy port) and is stopped by the suite or by the cleanup suite (z-cleanup.test.ts).
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { ServiceTarget } from "@own/runtime"
import { Controller } from "../../src/controller.js"
import { Operations } from "../../src/operations.js"
import { Broker } from "../../src/protocol/broker.js"
import { RemoteClient } from "../../src/remote/client.js"
import { Liveness } from "../../src/ssh/liveness.js"
import { SshRunner } from "../../src/ssh/runner.js"
import { minimalEnv, shortArgs } from "../../src/vendor/ssh/command.js"
import * as Harness from "../harness/remote.js"
import * as Env from "./env.js"

const run = Env.enabled ? describe : describe.skip
const BUILD = "real-host-a"

async function until<T>(read: () => Promise<T | undefined | false> | T | undefined | false, timeoutMs = 30_000, stepMs = 250) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await read()
    if (value) return value
    if (Date.now() > deadline) throw new Error("timeout")
    await Bun.sleep(stepMs)
  }
}

run(`real host ${Env.ALIAS}: transport, install, lifecycle (phase A)`, () => {
  const state = {} as {
    controller: Controller
    operations: Operations
    broker: ReturnType<typeof Harness.fakeBroker>
    unprovide: () => void
    hostId: string
    events: Array<{ name: string; data: any }>
    ports: Awaited<ReturnType<typeof Env.ports>>
  }
  const ownHome = () => state.controller.record(state.hostId)!.remote!.ownHome
  const view = () => state.controller.view(state.hostId)!

  async function connect(input: { clientId?: string; hostKeyPrompt?: boolean; background?: boolean } = { clientId: "tab-a" }) {
    await state.controller.connect(state.hostId, input)
    await state.controller.settled(state.hostId)
    return view()
  }

  /**
   * Stops our service with its own binary (`service stop` reads our registration file). Like ops' own `service stop`
   * (04 §8.11.17), with TMPDIR=<OWN_HOME>/tmp: without it Bun extracts its native module to /tmp/.bun-<uid>-*.
   */
  async function stopService() {
    const result = await Env.hostSh(String.raw`set -u
reg="$HOME/.local/state/opencode/service-own.json"
pid=$(sed -n 's/.*"pid"[[:space:]]*:[[:space:]]*\([0-9]*\).*/\1/p' "$reg" 2>/dev/null | head -n 1)
own_tmp="$HOME/.local/share/own-open-code/tmp"
mkdir -p "$own_tmp" && chmod 700 "$own_tmp"
TMPDIR="$own_tmp" "$HOME/.local/share/own-open-code/app/current/opencode" service stop </dev/null >/dev/null 2>&1
i=0; while [ -n "$pid" ] && [ -d "/proc/$pid" ] && [ $i -lt 20 ]; do sleep 0.5; i=$((i+1)); done
echo "PID=$pid"; if [ -n "$pid" ] && [ -d "/proc/$pid" ]; then echo ALIVE=1; else echo ALIVE=0; fi
`)
    return Env.kv(result.stdout)
  }

  beforeAll(async () => {
    Env.prepareSshFiles()
    state.ports = await Env.ports()
    state.events = []
    state.broker = Harness.fakeBroker()
    state.unprovide = Broker.provideLocal(BUILD, state.broker.broker)
    state.controller = new Controller({
      buildId: BUILD,
      version: Env.VERSION,
      ownHome: Env.OWN_HOME,
      options: {
        sshCommand: Env.sshCommand(),
        askpassHelper: path.join(Env.APP, "opencode.exe"),
        remoteBundles: path.join(Env.APP, "remote"),
        sshDir: Env.SSH_DIR,
        keepIntervalSeconds: 5,
        readyTimeoutMs: 25_000,
        backoffMs: [3_000, 5_000, 10_000],
        ownerTimeoutMs: 300_000,
      },
    })
    state.operations = new Operations(state.controller)
    await state.controller.start()
    state.controller.hub.subscribe((event) => void state.events.push(event as never))
  }, 60_000)

  afterAll(async () => {
    Env.evidence("a-events.json", state.events)
    await state.controller?.close()
    state.unprovide?.()
    state.broker?.close()
  }, 60_000)

  test("host facts and the before listing (read only)", async () => {
    const file = path.join(Env.EVIDENCE, "before.txt")
    if (fs.existsSync(file)) await Env.assertListingHost(fs.readFileSync(file, "utf8"))
    if (!fs.existsSync(file)) {
      const before = await Env.hostSh(Env.SNAPSHOT_SCRIPT)
      expect(before.code).toBe(0)
      Env.evidence("before.txt", before.stdout)
    }
    const facts = await Env.hostSh(String.raw`uname -srm; ldd --version | head -n 1; id -u; echo "SHELL=$SHELL"
findmnt -no OPTIONS -T /tmp; findmnt -no OPTIONS -T "$HOME"; loginctl show-user "$(id -u)" -p Linger
cat /proc/sys/kernel/yama/ptrace_scope; command -v opencode || echo "no upstream opencode on PATH"`)
    Env.evidence("host-facts.txt", facts.stdout)
    expect(facts.stdout).toContain("x86_64")
  }, 60_000)

  test("RG5: a background attempt with an unknown host key pauses without any prompt (StrictHostKeyChecking=yes)", async () => {
    const added = await state.controller.addHost({ alias: Env.ALIAS })
    expect(added.ok).toBe(true)
    if (!added.ok) return
    state.hostId = added.record.id
    // The egress sink for everything https the remote service might try (04 §5.6 host env): any real provider or
    // download attempt lands on this PC's sink instead of leaving the host (phase B serves and logs it).
    await state.controller.updateHost(state.hostId, {
      env: {
        HTTPS_PROXY: `http://127.0.0.1:${state.ports.sink}`,
        https_proxy: `http://127.0.0.1:${state.ports.sink}`,
        NO_PROXY: "127.0.0.1,localhost",
        OPENCODE_DISABLE_MODELS_FETCH: "1",
      },
    })
    expect(fs.readFileSync(Env.KNOWN_HOSTS, "utf8")).toBe("")
    const before = state.events.length
    const result = await connect({ background: true })
    expect(result).toMatchObject({ paused: true, error: "host_key", detail: "unknown" })
    expect(state.events.slice(before).filter((event) => event.name === "host.prompt")).toEqual([])
    Env.evidence("rg5-background-unknown.json", { view: result, stderr: state.controller.host(state.hostId)!.stderrTail })
  }, 90_000)

  test("RG5: the host-key flow shows ssh.exe's real question as a hostKey prompt; only 'trust' from the owner answers", async () => {
    const prompts: any[] = []
    const unsubscribe = state.controller.hub.subscribe((event) => {
      if (event.name === "host.prompt") prompts.push(event.data)
    })
    await state.controller.connect(state.hostId, { clientId: "tab-a", hostKeyPrompt: true })
    const prompt = await until(() => prompts[0], 60_000)
    // The fingerprint shown is the one the user's own known_hosts has for this host.
    const hostname = fs.readFileSync(Env.SSH_CONFIG, "utf8").match(/HostName (\S+)/)![1]!
    const expected = spawnSync(
      "C:\\Windows\\System32\\OpenSSH\\ssh-keygen.exe",
      ["-l", "-F", hostname, "-f", Env.KNOWN_HOSTS_COPY],
      { encoding: "utf8", windowsHide: true },
    ).stdout
    Env.evidence("rg5-prompt.json", { prompt, userKnownHostsFingerprint: expected })
    expect(prompt.kind).toBe("hostKey")
    expect(prompt.text).toMatch(/authenticity of host/i)
    expect(prompt.text).toMatch(/\(yes\/no\/\[fingerprint\]\)\?/)
    expect(prompt.fingerprint).toMatch(/^SHA256:/)
    expect(expected).toContain(prompt.fingerprint)
    expect(prompt.keyType).toBe("ED25519")
    expect(prompt.ownerClientId).toBe("tab-a")
    expect((await state.controller.respond(state.hostId, prompt.promptId, "tab-b", "trust")).ok).toBe(false)
    expect((await state.controller.respond(state.hostId, prompt.promptId, "tab-a", "yes")).ok).toBe(false)
    expect((await state.controller.respond(state.hostId, prompt.promptId, "tab-a", "trust")).ok).toBe(true)
    await state.controller.settled(state.hostId)
    unsubscribe()
    // ssh.exe wrote the key into the TEMP known_hosts (the user's file is untouched).
    expect(fs.readFileSync(Env.KNOWN_HOSTS, "utf8")).toContain("ssh-ed25519")
    const current = view()
    expect(current.stage).toBe("needs_install")
    expect(current.platform).toMatchObject({ os: "linux", arch: "x86_64", target: "linux-x64-baseline", libc: "glibc" })
    expect(current.hostIdentity).toMatch(/^sha256:[0-9a-f]{64}$/)
    const record = state.controller.record(state.hostId)!
    expect(record.remote).toMatchObject({
      ownHome: `${record.remote!.home}/.local/share/own-open-code`,
      configDir: `${record.remote!.home}/.config/own-open-code`,
      stateDir: `${record.remote!.home}/.local/state/opencode`,
      socketDir: `${record.remote!.home}/.local/share/own-open-code/run`,
    })
    const inspect = state.controller.host(state.hostId)!.inspect!
    Env.evidence("inspect.json", inspect)
  }, 120_000)

  test("RG5: a changed host key pauses as host_key(changed); known_hosts is never edited by own-remote", async () => {
    const saved = fs.readFileSync(Env.KNOWN_HOSTS, "utf8")
    const keyDir = path.join(Env.ROOT, "bogus-key")
    fs.rmSync(keyDir, { recursive: true, force: true })
    fs.mkdirSync(keyDir, { recursive: true })
    spawnSync("C:\\Windows\\System32\\OpenSSH\\ssh-keygen.exe", ["-q", "-t", "ed25519", "-N", "", "-f", path.join(keyDir, "k")], {
      windowsHide: true,
    })
    const bogus = fs.readFileSync(path.join(keyDir, "k.pub"), "utf8").trim().split(" ").slice(0, 2).join(" ")
    const hostField = saved.trim().split(/\s+/)[0]!
    fs.writeFileSync(Env.KNOWN_HOSTS, `${hostField} ${bogus}\n`)
    try {
      const result = await connect({ clientId: "tab-a" })
      Env.evidence("rg5-changed.json", { view: result, stderr: state.controller.host(state.hostId)!.stderrTail })
      expect(result).toMatchObject({ paused: true, error: "host_key", detail: "changed" })
      expect(fs.readFileSync(Env.KNOWN_HOSTS, "utf8")).toBe(`${hostField} ${bogus}\n`)
    } finally {
      fs.writeFileSync(Env.KNOWN_HOSTS, saved)
      fs.rmSync(keyDir, { recursive: true, force: true })
    }
  }, 120_000)

  test("RG5: an encrypted key's passphrase question is classified as passphrase (real ssh.exe text); cancel falls through", async () => {
    const keyDir = path.join(Env.ROOT, "pem-key")
    fs.rmSync(keyDir, { recursive: true, force: true })
    fs.mkdirSync(keyDir, { recursive: true })
    const key = path.join(keyDir, "k")
    spawnSync("C:\\Windows\\System32\\OpenSSH\\ssh-keygen.exe", ["-q", "-t", "rsa", "-b", "2048", "-m", "PEM", "-N", "fake-passphrase-0", "-f", key], {
      windowsHide: true,
    })
    fs.rmSync(`${key}.pub`, { force: true })
    // The encrypted key comes first, the user's key (from the temp config) after it: nothing unknown is offered to the
    // server, and the cancelled question falls through to the working key.
    const runner = new SshRunner.Runner({ command: [...Env.sshCommand(), "-i", key] })
    const prompts: any[] = []
    const askpass: SshRunner.Askpass = await runner.askpass({
      binary: path.join(Env.APP, "opencode.exe"),
      prompt: (prompt) => {
        prompts.push(prompt)
        void askpass.respond(prompt.id, null)
      },
      clear: () => {},
    })
    try {
      const result = await runner.run({
        args: [...shortArgs({ host: Env.ALIAS, args: ["-o", "StrictHostKeyChecking=yes"] }), Env.ALIAS, "echo OWN_PASSPHRASE_FALLTHROUGH=1"],
        env: { ...minimalEnv(), ...askpass.env },
        timeout: 60_000,
      })
      Env.evidence("rg5-passphrase.json", { prompts: prompts.map(({ id: _id, ...rest }) => rest), ok: result.ok })
      expect(prompts.length).toBeGreaterThanOrEqual(1)
      expect(prompts[0].kind).toBe("passphrase")
      expect(prompts[0].text).toMatch(/Enter passphrase for key/)
      expect(result.ok && result.stdout).toContain("OWN_PASSPHRASE_FALLTHROUGH=1")
    } finally {
      await askpass.close()
      await runner.dispose()
      fs.rmSync(keyDir, { recursive: true, force: true })
    }
  }, 120_000)

  test("RG2/RG3: prepare uploads the release tarball; the host runs the Linux binary's --version; no root", async () => {
    const plan = await state.operations.preparePlan(state.hostId)
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    Env.evidence("prepare-plan.json", plan.output)
    expect(plan.output).toMatchObject({ root: false, platform: { target: "linux-x64-baseline" } })
    expect(plan.output.install.version).toBe(Env.VERSION)
    const started = Date.now()
    const executed = await state.operations.prepareExecute(plan.output.nonce)
    Env.evidence("prepare-execute.json", { executed, seconds: (Date.now() - started) / 1000 })
    expect(executed.ok && executed.output.ok).toBe(true)
    const version = await Env.hostSh(String.raw`set -u
app="$HOME/.local/share/own-open-code/app"
TMPDIR="$HOME/.local/share/own-open-code/tmp" "$app/${Env.VERSION}/opencode" --version; echo "EXIT=$?"
stat -c '%a %n' "$HOME/.local/share/own-open-code" "$app" "$app/${Env.VERSION}" "$app/${Env.VERSION}/opencode" "$HOME/.local/share/own-open-code/run" "$HOME/.local/share/own-open-code/tmp"
echo "CURRENT=$(readlink "$app/current")"; head -n 3 "$app/${Env.VERSION}/.verified"; file -b "$app/${Env.VERSION}/opencode" 2>/dev/null | cut -c1-120`)
    Env.evidence("rg2-version.txt", version.stdout + version.stderr)
    expect(version.stdout).toContain(Env.VERSION)
    expect(version.stdout).toContain("EXIT=0")
    expect(version.stdout).toContain(`CURRENT=${Env.VERSION}`)
    expect(version.stdout).toMatch(/^700 .*own-open-code$/m)
    expect(version.stdout).toMatch(/^755 .*\/opencode$/m)
  }, 900_000)

  test("RG3/RG4/RG16: connect starts the real service; -L on 127.0.k.2; -R stream socket 0600; the broker handshake runs over it", async () => {
    const result = await connect()
    Env.evidence("connect-view.json", result)
    expect(result.stage).toBe("ready")
    expect(result.versions.remoteRunning).toBe(Env.VERSION)
    const record = state.controller.record(state.hostId)!
    expect(record.broker.mode).toBe("socket")
    await until(() => state.broker.log.find((entry) => entry.event === "connected" && entry.epoch === result.epoch), 60_000)
    // ssh.exe itself listens on the host loopback address (Win32-OpenSSH binds 127.0.k.2).
    const tunnelPid = state.controller.host(state.hostId)!.live!.tunnel.pid!
    const netstat = spawnSync("netstat", ["-ano", "-p", "tcp"], { encoding: "utf8", windowsHide: true }).stdout
    const listen = netstat.split(/\r?\n/).filter((line) => /LISTENING/.test(line) && line.trim().endsWith(` ${tunnelPid}`))
    Env.evidence("rg16-netstat.txt", listen.join("\n"))
    expect(listen.some((line) => line.includes(`${result.loopback}:${result.localPort}`))).toBe(true)
    // Local address column only: nothing of the tunnel on 127.0.0.1 or all interfaces.
    const locals = listen.map((line) => line.trim().split(/\s+/)[1] ?? "")
    expect(locals.every((address) => address.startsWith(`${result.loopback}:`))).toBe(true)
    const epoch = result.epoch
    const host = await Env.hostSh(String.raw`set -u
own="$HOME/.local/share/own-open-code"; reg="$HOME/.local/state/opencode/service-own.json"
pid=$(sed -n 's/.*"pid"[[:space:]]*:[[:space:]]*\([0-9]*\).*/\1/p' "$reg" | head -n 1)
echo "PID=$pid"; echo "EXE=$(readlink /proc/$pid/exe)"
echo "SOCK=$(stat -c '%a %U %F' "$own/run/broker-${epoch}.sock" 2>&1)"
echo "RUN=$(stat -c '%a %U' "$own/run")"
echo "REG=$(stat -c '%a' "$reg")"; echo "SVC=$(stat -c '%a' "$HOME/.config/opencode/service-own.json") $(stat -c '%a' "$HOME/.config/own-open-code/service-own.json")"
echo "CURRENT_EPOCH=$(cat "$own/run/broker.current")"
echo "LISTEN=$(ss -Htlnp 2>/dev/null | grep "pid=$pid," | awk '{print $4}' | tr '\n' ' ')"
echo "ENV_NAMES=$(tr '\0' '\n' < /proc/$pid/environ | sed 's/=.*//' | sort | tr '\n' ' ')"
echo "ENV_TMPDIR=$(tr '\0' '\n' < /proc/$pid/environ | sed -n 's/^TMPDIR=//p')"
echo "ENV_OWN=$(tr '\0' '\n' < /proc/$pid/environ | grep -E '^(OWN_OPEN_CODE|OWN_REMOTE|OPENCODE_CONFIG_PROJECT_DISABLE|OPENCODE_CONFIG_PROJECT_INSTRUCTIONS|OPENCODE_CONFIG_DIR|HTTPS_PROXY)=' | tr '\n' ' ')"
echo "TMP_ENTRIES=$(ls -A "$own/tmp" | head -n 20 | tr '\n' ' ')"
echo "SOCK_OWNER=$(ss -Hxlp 2>/dev/null | grep -F "broker-${epoch}.sock" | grep -o 'pid=[0-9]*' | head -n 1)"`)
    const facts = Env.kv(host.stdout)
    Env.evidence("rg3-rg4-service.txt", host.stdout)
    expect(facts.get("EXE")).toBe(`${record.remote!.ownHome}/app/${Env.VERSION}/opencode`)
    expect(facts.get("SOCK")).toBe(`600 ${record.remote!.home.split("/").at(-1)} socket`)
    expect(facts.get("RUN")?.startsWith("700 ")).toBe(true)
    expect(facts.get("REG")).toBe("600")
    expect(facts.get("SVC")).toBe("600 600")
    expect(facts.get("CURRENT_EPOCH")).toBe(String(epoch))
    // The API port and own-accounts' fail-closed sink (04 §8.6), both loopback only.
    const listening = (facts.get("LISTEN") ?? "").split(" ").filter(Boolean)
    expect(listening).toContain(`127.0.0.1:${record.remotePort}`)
    expect(listening.every((address) => address.startsWith("127.0.0.1:"))).toBe(true)
    const names = (facts.get("ENV_NAMES") ?? "").split(" ").filter(Boolean)
    expect(names.filter((name) => /API_KEY$|^ANTHROPIC_|^CLAUDE_|^OPENCODE_CLAUDE_AUTH_/.test(name))).toEqual([])
    expect(facts.get("ENV_TMPDIR")).toBe(`${record.remote!.ownHome}/tmp`)
    expect(facts.get("ENV_OWN")).toContain("OWN_REMOTE=1")
    // A new host reads the repository's instruction files only (04 §5.6): project config off, instructions on.
    expect(facts.get("ENV_OWN")).toContain("OPENCODE_CONFIG_PROJECT_DISABLE=1")
    expect(facts.get("ENV_OWN")).toContain("OPENCODE_CONFIG_PROJECT_INSTRUCTIONS=1")
    expect(state.controller.view(state.hostId)!.projectConfig).toBe("instructions")
    // The agent probe ran in the service with the agent shell's spawn path (04 §6.1 step 9).
    Env.evidence("agent-probe.json", state.controller.host(state.hostId)!.probe)
    expect(state.controller.host(state.hostId)!.probe).toBeDefined()
  }, 300_000)

  test("RG16: the tunnel endpoint answers own-remote's short token on 127.0.k.2 and refuses a forged one", async () => {
    const resolved = await state.controller.resolve(state.hostId)
    expect(resolved?.url).toMatch(/^http:\/\/127\.0\.\d+\.2:\d+$/)
    if (!resolved || resolved.url === null) return
    const ok = await fetch(new URL("/api/info", resolved.url), { headers: { authorization: ServiceTarget.basic(resolved.token) } })
    const info = (await ok.json()) as Record<string, unknown>
    Env.evidence("rg16-info.json", info)
    expect(ok.status).toBe(200)
    expect(info.version).toBe(Env.VERSION)
    const forged = await fetch(new URL("/api/info", resolved.url), {
      headers: { authorization: ServiceTarget.basic(`${Math.floor(Date.now() / 1000) + 60}.forged`) },
    })
    expect(forged.status).toBe(401)
    const none = await fetch(new URL("/api/info", resolved.url))
    expect(none.status).toBe(401)
  }, 60_000)

  test("RG10: the broker key armed into the service is nowhere on the remote disk, env, argv or logs", async () => {
    const key = state.broker.keys.get(state.hostId)!.key
    const needles = [key.toString("base64url"), key.toString("base64"), key.toString("hex")]
    const script = String.raw`set -u
pid=$(sed -n 's/.*"pid"[[:space:]]*:[[:space:]]*\([0-9]*\).*/\1/p' "$HOME/.local/state/opencode/service-own.json" | head -n 1)
n=0
for needle in ${needles.map((value) => `'${value}'`).join(" ")}; do
  c=$(grep -rlaF -- "$needle" "$HOME/.local/share/own-open-code" "$HOME/.config/own-open-code" "$HOME/.config/opencode" \
      "$HOME/.local/state/opencode" "$HOME/.local/share/opencode" "$HOME/.cache/opencode" 2>/dev/null | wc -l)
  e=$(tr '\0' '\n' < /proc/$pid/environ | grep -cF -- "$needle")
  a=$(tr '\0' ' ' < /proc/$pid/cmdline | grep -cF -- "$needle")
  p=$(ps -eo args | grep -v grep | grep -cF -- "$needle")
  echo "HITS_FILES=$c HITS_ENV=$e HITS_ARGV=$a HITS_PS=$p"
done
echo "LOG_FILES=$(find "$HOME/.local/share/opencode" -name '*.log' 2>/dev/null | wc -l)"
echo "ARM_LOG_LINES=$(grep -rhaF 'broker.arm' "$HOME/.local/share/opencode" 2>/dev/null | wc -l)"
grep -rhaF 'broker.arm' "$HOME/.local/share/opencode" 2>/dev/null | head -n 3 | cut -c1-400`
    const result = await Env.hostSh(script)
    Env.evidence("rg10-broker-key.txt", result.stdout)
    const lines = result.stdout.split("\n").filter((line) => line.startsWith("HITS_"))
    expect(lines).toHaveLength(3)
    for (const line of lines) expect(line).toBe("HITS_FILES=0 HITS_ENV=0 HITS_ARGV=0 HITS_PS=0")
    for (const needle of needles) expect(result.stdout).not.toContain(needle)
  }, 120_000)

  test("RG4: a leftover socket of an older epoch does not block the next tunnel and is removed", async () => {
    await state.controller.disconnect(state.hostId)
    const left = await Env.hostSh(String.raw`set -u
run="$HOME/.local/share/own-open-code/run"
python3 -c 'import socket,sys; s=socket.socket(socket.AF_UNIX); s.bind(sys.argv[1])' "$run/broker-1000.sock"
echo "LEFT=$(stat -c '%F' "$run/broker-1000.sock")"`)
    expect(Env.kv(left.stdout).get("LEFT")).toBe("socket")
    const result = await connect()
    expect(result.stage).toBe("ready")
    await until(() => state.broker.log.find((entry) => entry.event === "connected" && entry.epoch === result.epoch), 60_000)
    const after = await Env.hostSh(String.raw`ls -A1 "$HOME/.local/share/own-open-code/run"`)
    Env.evidence("rg4-leftover.txt", after.stdout)
    expect(after.stdout).not.toContain("broker-1000.sock")
    expect(after.stdout).toContain(`broker-${result.epoch}.sock`)
  }, 180_000)

  test("RG4: a drop without FIN (the remote sshd session frozen) → reconnect with a new epoch; SIGHUP of the old session later leaves the new broker connection up", async () => {
    const old = view()
    const oldTunnel = state.controller.host(state.hostId)!.live!.tunnel
    // The per-connection sshd process of our user is not dumpable, so ss -p cannot name it (FREEZE_KEEP_SCRIPT).
    const frozen = await Env.freezeKeep()
    const frozenFacts = Env.kv(frozen.stdout)
    Env.evidence("rg4-freeze.txt", frozen.stdout)
    expect(frozenFacts.get("STOPPED")).toBe("1")
    const sshd = frozenFacts.get("SSHD")!
    const started = Date.now()
    try {
      // Only ssh.exe's keepalive notices (every 4 s, 2 unanswered: at most 12 s after its last received byte, before
      // own.15 15 s × 3 = 45-60 s); then own-remote reconnects in the background.
      await oldTunnel.exited
      const detectedMs = Date.now() - started
      console.log(`[RG4] the frozen session's silence ended the tunnel after ${detectedMs} ms`)
      const next = await until(() => {
        const current = view()
        return current.stage === "ready" && current.epoch > old.epoch ? current : undefined
      }, 180_000, 500)
      await until(() => state.broker.log.find((entry) => entry.event === "connected" && entry.epoch === next.epoch), 60_000)
      // The old keep part (still running under the frozen sshd) ends by itself once broker.current moved on.
      const selfEnd = await until(async () => {
        const check = await Env.hostSh(String.raw`ps --ppid ${sshd} -o pid=,args= | grep -c 'sh -s' || true`)
        return check.stdout.trim() === "0" ? check : undefined
      }, 60_000, 2_000)
      expect(selfEnd.stdout.trim()).toBe("0")
      const hup = await Env.hostSh(String.raw`set -u
kill -CONT ${sshd}; kill -HUP ${sshd}; sleep 2
if [ -d /proc/${sshd} ]; then echo OLD_ALIVE=1; else echo OLD_ALIVE=0; fi
echo "NEW_SOCK=$(stat -c '%F' "$HOME/.local/share/own-open-code/run/broker-${next.epoch}.sock" 2>&1)"
echo "OLD_SOCK=$(ls "$HOME/.local/share/own-open-code/run/broker-${old.epoch}.sock" 2>&1 | grep -c 'No such')"
echo "CURRENT=$(cat "$HOME/.local/share/own-open-code/run/broker.current")"`)
      const facts = Env.kv(hup.stdout)
      // The harness broker double completes hello/challenge/auth but answers a bare `ready` the real client refuses,
      // so the client keeps re-dialing: every successful auth after the SIGHUP proves the new epoch's socket, sshd
      // session and ssh.exe still carry the broker stream (the full broker keeps it connected: phase B).
      const authsAfterHup = () => state.broker.log.filter((entry) => entry.event === "connected" && entry.epoch === next.epoch).length
      const atHup = authsAfterHup()
      await Bun.sleep(5_000)
      const remote = await RemoteClient.call<{ broker: { state: string; epoch: number | null } }>(
        state.controller.endpoint(state.hostId)!,
        "agent.status",
        {},
      )
      Env.evidence("rg4-drop.json", {
        old: old.epoch,
        next: next.epoch,
        detectedMs,
        facts: Object.fromEntries(facts),
        remote,
        authsAtHup: atHup,
        authsAfter5s: authsAfterHup(),
      })
      expect(detectedMs).toBeLessThanOrEqual(Liveness.SILENT_LIMIT_MS + 3_000)
      expect(facts.get("OLD_ALIVE")).toBe("0")
      expect(facts.get("NEW_SOCK")).toBe("socket")
      expect(facts.get("OLD_SOCK")).toBe("1")
      expect(facts.get("CURRENT")).toBe(String(next.epoch))
      expect(authsAfterHup()).toBeGreaterThan(atHup)
      expect(remote.ok && remote.output.broker.epoch).toBe(next.epoch)
      expect(view().stage).toBe("ready")
    } finally {
      await Env.hostSh(`kill -CONT ${sshd} 2>/dev/null; kill -HUP ${sshd} 2>/dev/null; true`)
    }
  }, 420_000)

  test("RG4: TCP fallback (a busy remote port first) works without reading ssh's 'Allocated port' line", async () => {
    await state.controller.disconnect(state.hostId)
    const busy = await Env.hostSh(String.raw`set -u
for i in 1 2 3 4 5 6 7 8 9 10; do
  port=$((20000 + $(od -An -N2 -tu2 /dev/urandom | tr -d ' ') % 40000))
  ss -Htln | awk '{print $4}' | grep -q ":$port$" || break
done
nohup python3 -c 'import socket,sys,time; s=socket.socket(); s.bind(("127.0.0.1", int(sys.argv[1]))); s.listen(1); time.sleep(900)' "$port" >/dev/null 2>&1 </dev/null &
echo "PORT=$port"; echo "PID=$!"; sleep 1; echo "LISTEN=$(ss -Htln | awk '{print $4}' | grep -c ":$port$")"`)
    const busyFacts = Env.kv(busy.stdout)
    expect(busyFacts.get("LISTEN")).toBe("1")
    const busyPort = Number(busyFacts.get("PORT"))
    try {
      await state.controller.registry.patchHost(state.hostId, { broker: { mode: "tcp", tcpPort: busyPort } })
      const result = await connect()
      const record = state.controller.record(state.hostId)!
      Env.evidence("rg4-tcp.json", { view: result, broker: record.broker, busyPort })
      expect(result.stage).toBe("ready")
      expect(record.broker.mode).toBe("tcp")
      expect(record.broker.tcpPort).not.toBe(busyPort)
      await until(() => state.broker.log.find((entry) => entry.event === "connected" && entry.epoch === result.epoch), 60_000)
      // The -R listener exists on the host's loopback only (sshd's session process is not dumpable: ss -p cannot name it).
      const check = await Env.hostSh(`ss -Htln | awk '{print $4}' | grep -E ':${record.broker.tcpPort}$'`)
      expect(check.stdout.trim().split(/\s+/)).toEqual([`127.0.0.1:${record.broker.tcpPort}`])
    } finally {
      await Env.hostSh(`kill ${busyFacts.get("PID")} 2>/dev/null; true`)
      await state.controller.disconnect(state.hostId)
      await state.controller.registry.patchHost(state.hostId, { broker: { mode: "socket", tcpPort: null } })
    }
    const back = await connect()
    expect(back.stage).toBe("ready")
    expect(state.controller.record(state.hostId)!.broker.mode).toBe("socket")
  }, 300_000)

  test("RG3: a registration whose pid is dead is moved aside, not reported as version_skew; a new service starts", async () => {
    await state.controller.disconnect(state.hostId)
    const stopped = await stopService()
    expect(stopped.get("ALIVE")).toBe("0")
    const write = await Env.hostSh(String.raw`set -u
reg="$HOME/.local/state/opencode/service-own.json"
pid=999999; while [ -d /proc/$pid ]; do pid=$((pid - 1)); done
printf '{"url":"http://127.0.0.1:1","password":"stale","version":"${Env.VERSION}","pid":%s}\n' "$pid" > "$reg"; chmod 600 "$reg"; echo "DEAD=$pid"`)
    const dead = Env.kv(write.stdout).get("DEAD")
    const result = await connect()
    expect(result.stage).toBe("ready")
    expect(result.error).toBeNull()
    const after = await Env.hostSh(String.raw`sed -n 's/.*"pid"[[:space:]]*:[[:space:]]*\([0-9]*\).*/STALE_PID=\1/p' "$HOME/.local/state/opencode/service-own.json.stale"`)
    Env.evidence("rg3-dead-pid.txt", after.stdout)
    expect(Env.kv(after.stdout).get("STALE_PID")).toBe(dead)
  }, 240_000)

  test("RG3: a registration whose pid now belongs to another program is moved aside and that program is not killed", async () => {
    await state.controller.disconnect(state.hostId)
    expect((await stopService()).get("ALIVE")).toBe("0")
    const other = await Env.hostSh(String.raw`set -u
nohup /bin/sleep 900 >/dev/null 2>&1 </dev/null &
pid=$!; sleep 0.5
reg="$HOME/.local/state/opencode/service-own.json"
printf '{"url":"http://127.0.0.1:1","password":"stale","version":"${Env.VERSION}","pid":%s}\n' "$pid" > "$reg"; chmod 600 "$reg"
echo "OTHER=$pid"; echo "EXE=$(readlink /proc/$pid/exe)"`)
    const pid = Env.kv(other.stdout).get("OTHER")!
    try {
      const result = await connect()
      expect(result.stage).toBe("ready")
      await Bun.sleep(5_000)
      const check = await Env.hostSh(String.raw`if [ -d /proc/${pid} ]; then echo OTHER_ALIVE=1; else echo OTHER_ALIVE=0; fi
sed -n 's/.*"pid"[[:space:]]*:[[:space:]]*\([0-9]*\).*/STALE_PID=\1/p' "$HOME/.local/state/opencode/service-own.json.stale"`)
      Env.evidence("rg3-reused-pid.txt", other.stdout + check.stdout)
      expect(Env.kv(check.stdout).get("OTHER_ALIVE")).toBe("1")
      expect(Env.kv(check.stdout).get("STALE_PID")).toBe(pid)
    } finally {
      await Env.hostSh(`[ "$(readlink /proc/${pid}/exe)" = /usr/bin/sleep ] && kill ${pid}; true`)
    }
  }, 240_000)

  test("RG3: a hung service of the same version → service_unresponsive (paused), never killed automatically", async () => {
    await state.controller.disconnect(state.hostId)
    const stop = await Env.hostSh(String.raw`pid=$(sed -n 's/.*"pid"[[:space:]]*:[[:space:]]*\([0-9]*\).*/\1/p' "$HOME/.local/state/opencode/service-own.json" | head -n 1)
kill -STOP "$pid" && echo "HUNG=$pid"`)
    const pid = Env.kv(stop.stdout).get("HUNG")!
    try {
      const result = await connect()
      const check = await Env.hostSh(`echo "STATE=$(awk '{print $3}' /proc/${pid}/stat 2>/dev/null)"`)
      Env.evidence("rg3-hung.json", { view: result, remote: check.stdout })
      expect(result).toMatchObject({ paused: true, error: "service_unresponsive" })
      expect(Env.kv(check.stdout).get("STATE")).toBe("T")
    } finally {
      await Env.hostSh(`kill -CONT ${pid} 2>/dev/null; true`)
    }
    const back = await connect()
    expect(back.stage).toBe("ready")
  }, 240_000)

  test("RG3: a user-changed service hostname (0.0.0.0) stops ensure with service_not_loopback and starts nothing", async () => {
    await state.controller.disconnect(state.hostId)
    expect((await stopService()).get("ALIVE")).toBe("0")
    await Env.hostSh(String.raw`f="$HOME/.config/opencode/service-own.json"; sed -i 's/"hostname":"127.0.0.1"/"hostname":"0.0.0.0"/' "$f"; grep -c '0.0.0.0' "$f"`)
    try {
      const result = await connect()
      const check = await Env.hostSh(String.raw`echo "REG=$([ -f "$HOME/.local/state/opencode/service-own.json" ] && echo present || echo absent)"
echo "ANY=$(ss -Htln | awk '{print $4}' | grep -c '^0.0.0.0:${state.controller.record(state.hostId)!.remotePort}$')"
echo "OURS=$(for p in $(ps -u "$(id -u)" -o pid=); do readlink /proc/$p/exe 2>/dev/null; done | grep -c own-open-code/app)"`)
      Env.evidence("rg3-not-loopback.json", { view: result, remote: check.stdout })
      expect(result).toMatchObject({ paused: true, error: "service_not_loopback" })
      expect(Env.kv(check.stdout).get("ANY")).toBe("0")
      expect(Env.kv(check.stdout).get("OURS")).toBe("0")
    } finally {
      await Env.hostSh(String.raw`f="$HOME/.config/opencode/service-own.json"; sed -i 's/"hostname":"0.0.0.0"/"hostname":"127.0.0.1"/' "$f"`)
    }
    const back = await connect()
    expect(back.stage).toBe("ready")
  }, 240_000)

  test("end of phase A: disconnect leaves the service running on the host (04 §6.2)", async () => {
    await state.controller.disconnect(state.hostId)
    const check = await Env.hostSh(String.raw`pid=$(sed -n 's/.*"pid"[[:space:]]*:[[:space:]]*\([0-9]*\).*/\1/p' "$HOME/.local/state/opencode/service-own.json" | head -n 1)
[ -n "$pid" ] && [ -d "/proc/$pid" ] && echo RUNNING=1 || echo RUNNING=0`)
    expect(Env.kv(check.stdout).get("RUNNING")).toBe("1")
    fs.writeFileSync(path.join(Env.ROOT, "host-id"), state.hostId)
  }, 60_000)
})
