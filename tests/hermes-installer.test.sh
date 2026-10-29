#!/usr/bin/env bash
# End-to-end test for integrations/hermes/install/emperor-hermes.sh (W7, design §8).
#
# Runs inside a disposable Ubuntu 24.04 container booted with systemd (PID 1) and a lingering
# user `jose` whose `systemd --user` manager runs the real units. Hermes itself is mocked
# (fake install.sh, launcher, gateway control socket and bridge package); no real keys, no
# network except the container's apt install, and no production host is touched.
#
# Covers: shellcheck, unit verification, packaging, doctor (plain/--plan/--measure), install
# (canary, idempotent, memory refusal, duplicate-runtime guard), migrate --all from a fake 0.3
# layout, update, rollback (--bridge-only, per profile, --all, after finalize), status,
# restart-gateway (--when-idle), shared topology, shared -> standalone switch, finalize, status --json,
# non-interactive install, remove, and the runtime host daemon (host connect against a fake Emperor,
# a restart job end to end, provision_agent and remove_agent jobs (0.22), no secrets in its frames,
# exit 78 when revoked, host disconnect).
#
# Usage: bash tests/hermes-installer.test.sh        (needs Docker; ~2-4 min, first build longer)
#        KEEP=1 bash tests/hermes-installer.test.sh (keep the container for debugging)
set -Eeuo pipefail

PIN_SHA=4d04303818b61bf3aa09278af48356315515965b

# ════════════════════════════════════ host side ════════════════════════════════════════════

host_main() {
    local repo image=emperor-hermes-installer-test:2 name="emperor-hermes-installer-test-$$" mount rc=0
    repo=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
    mount=$repo
    if command -v cygpath >/dev/null 2>&1; then mount=$(cygpath -w "$repo"); fi
    command -v docker >/dev/null || { echo "docker is required" >&2; exit 2; }

    echo "== building $image"
    docker build -q -t "$image" - >/dev/null <<'DOCKERFILE'
FROM ubuntu:24.04
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
      systemd systemd-sysv dbus dbus-user-session python3 git curl ca-certificates \
      shellcheck logrotate procps cron python3-pip \
 && rm -rf /var/lib/apt/lists/* \
 && pip3 install --break-system-packages --no-cache-dir "websockets==15.0.1" \
 && systemctl mask getty.target console-getty.service systemd-udevd.service \
      systemd-networkd-wait-online.service 2>/dev/null || true \
 && useradd -m -s /bin/bash -u 1000 jose 2>/dev/null || (userdel -r ubuntu && useradd -m -s /bin/bash -u 1000 jose) \
 && mkdir -p /var/lib/systemd/linger && touch /var/lib/systemd/linger/jose
STOPSIGNAL SIGRTMIN+3
CMD ["/sbin/init"]
DOCKERFILE

    # shellcheck disable=SC2317,SC2329 # invoked by the EXIT trap
    cleanup() {
        if [ "${KEEP:-0}" = 1 ]; then echo "kept container $name"; else docker rm -f "$name" >/dev/null 2>&1 || true; fi
    }
    trap cleanup EXIT
    MSYS_NO_PATHCONV=1 docker run -d --name "$name" --privileged --cgroupns=host \
        -v /sys/fs/cgroup:/sys/fs/cgroup:rw --tmpfs /run --tmpfs /run/lock --tmpfs /tmp:exec \
        -v "$mount:/repo:ro" "$image" >/dev/null

    echo "== waiting for systemd and the user manager"
    for _ in $(seq 1 60); do
        if docker exec "$name" systemctl is-active --quiet user@1000.service 2>/dev/null; then break; fi
        sleep 1
    done
    docker exec "$name" systemctl is-active --quiet user@1000.service || {
        docker exec "$name" systemctl --failed --no-pager || true
        echo "user manager did not start" >&2
        exit 1
    }
    MSYS_NO_PATHCONV=1 docker exec -u jose -w /home/jose \
        -e XDG_RUNTIME_DIR=/run/user/1000 -e DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus \
        "$name" bash /repo/tests/hermes-installer.test.sh --inside || rc=$?
    if [ "$rc" != 0 ]; then
        echo "== installer log (tail)"
        docker exec "$name" tail -n 60 /home/jose/.local/share/emperor-hermes/emperor-hermes.log 2>/dev/null || true
    fi
    exit "$rc"
}

# ════════════════════════════════════ container side ═══════════════════════════════════════

PASS=0
FAIL=0
EH=""
F=""

ok() { PASS=$((PASS + 1)); printf '  ok   %s\n' "$*"; }
bad() { FAIL=$((FAIL + 1)); printf '  FAIL %s\n' "$*"; }
check() { # description command...
    local d=$1
    shift
    if "$@" >/dev/null 2>&1; then ok "$d"; else bad "$d"; fi
}
check_not() {
    local d=$1
    shift
    if "$@" >/dev/null 2>&1; then bad "$d"; else ok "$d"; fi
}
eq() { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (got '$2', want '$3')"; fi; }
section() { printf '\n== %s\n' "$*"; }
active() { systemctl --user is-active --quiet "$1"; }
enabled() { systemctl --user is-enabled --quiet "$1"; }
mainpid() { systemctl --user show -p MainPID --value "$1"; }
contains() { grep -Fq -- "$2" "$1"; }
eh() { "$EH" "$@"; }
sqlite_has() { python3 -c 'import sqlite3, sys
rows = [r[0] for r in sqlite3.connect(sys.argv[1]).execute("select id from sessions")]
sys.exit(0 if sys.argv[2] in rows else 1)' "$1" "$2"; }
json_get() { python3 -c 'import json, sys; print(json.load(open(sys.argv[1])).get(sys.argv[2]))' "$1" "$2"; }

write_fakes() {
    F=$HOME/fakes
    mkdir -p "$F" "$HOME/.hermes" "$HOME/.local/bin"

    # Fake `hermes` CLI: config/plugins/profile commands and a gateway control socket.
    cat >"$F/hermes.py" <<'PY'
import json, os, signal, socket, sys, threading, uuid
args = sys.argv[1:]
install_dir = ""
if args[:1] == ["--install-dir"]:
    install_dir, args = args[1], args[2:]
root = os.path.expanduser("~/.hermes")
profile = None
if args[:1] == ["-p"]:
    profile, args = args[1], args[2:]
home = os.path.join(root, "profiles", profile) if profile else root
version = "0.22.4" if install_dir.endswith("v0.22.4") else "0.21.6"
def log(line):
    with open(os.path.join(root, "fake-hermes.log"), "a") as f:
        f.write(line + "\n")
who = profile or "default"
if args == ["--version"]:
    print("Hermes Agent v" + version); sys.exit(0)
cmd = args[0] if args else ""
if cmd == "config" and args[1] == "set":
    os.makedirs(home, exist_ok=True)
    with open(os.path.join(home, "config.yaml"), "a") as f:
        f.write("# set %s=%s\n" % (args[2], args[3]))
    log("%s config set %s=%s via %s" % (who, args[2], args[3], version)); sys.exit(0)
if cmd == "config" and args[1] in ("get", "unset"):
    cfg = os.path.join(home, "config.yaml")
    value = None
    for line in (open(cfg).read().splitlines() if os.path.exists(cfg) else []):
        if line.startswith("# set %s=" % args[2]):
            value = line.split("=", 1)[1]
        elif line == "# unset %s" % args[2]:
            value = None
    if value is None:
        print("Config key not set: %s" % args[2]); sys.exit(1)
    if args[1] == "unset":
        with open(cfg, "a") as f:
            f.write("# unset %s\n" % args[2])
        log("%s config unset %s via %s" % (who, args[2], version)); sys.exit(0)
    print(json.dumps(value)); sys.exit(0)
if cmd == "plugins" and args[1] == "enable":
    log("%s plugins enable %s via %s" % (who, args[2], version)); sys.exit(0)
if cmd == "profile" and args[1] == "create":
    os.makedirs(os.path.join(root, "profiles", args[2]), exist_ok=True); sys.exit(0)
if cmd == "gateway" and args[1] == "run":
    sock_path = os.path.join(home, "gateway.sock")
    try:
        os.unlink(sock_path)
    except FileNotFoundError:
        pass
    def served():
        if profile:
            return [home]
        homes = [root]
        pdir = os.path.join(root, "profiles")
        for name in sorted(os.listdir(pdir)) if os.path.isdir(pdir) else []:
            cfg = os.path.join(pdir, name, "config.yaml")
            text = open(cfg).read() if os.path.exists(cfg) else ""
            last = [l for l in text.splitlines() if l.startswith("# set gateway.standalone=")]
            if last and last[-1].endswith("=false"):
                homes.append(os.path.join(pdir, name))
        return homes
    instance = uuid.uuid4().hex
    srv = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    srv.bind(sock_path); srv.listen(8)
    log("%s gateway start pid=%d via %s" % (who, os.getpid(), version))
    signal.signal(signal.SIGTERM, lambda *a: os._exit(1))  # like Hermes: rc 1 on SIGTERM
    def handle(c):
        with c:
            c.recv(65536)
            res = {"protocol": 1, "kind": "hermes-gateway", "pid": os.getpid(), "state": "ready",
                   "code_version": version, "runtime_protocol": 1, "instance_id": instance,
                   "capabilities": ["session-authority-v1"],
                   "served_profiles": [{"profile_id": h, "home": h} for h in served()]}
            c.sendall(json.dumps({"ok": True, "protocol": 1, "id": 1, "result": res}).encode() + b"\n")
    while True:
        conn, _ = srv.accept()
        threading.Thread(target=handle, args=(conn,), daemon=True).start()
print("fake hermes: unsupported " + " ".join(args), file=sys.stderr); sys.exit(2)
PY

    # Fake Hermes install.sh (S-14 shape): checkout at the pin, launcher, managed venv.
    cat >"$F/install.sh" <<EOF
#!/usr/bin/env bash
set -euo pipefail
dir=""; branch=""; flags=""
while [ \$# -gt 0 ]; do
  case "\$1" in --dir) dir=\$2; shift ;; --branch) branch=\$2; shift ;; *) flags="\$flags \$1" ;; esac
  shift
done
echo "install \$branch \$dir\$flags" >> "\$HOME/.hermes/fake-install.log"
mkdir -p "\$dir/hermes_cli" "\$dir/.hermes/bin"
git -C "\$dir" init -q
echo $PIN_SHA > "\$dir/.git/HEAD"
: > "\$dir/hermes_cli/__init__.py"
# The host daemon needs the real websockets 15 (installed in the image); older images get a stub.
if ! python3 -c 'import websockets.asyncio.client' 2>/dev/null; then
  mkdir -p "\$dir/websockets"
  echo '__version__ = "15.0.1"' > "\$dir/websockets/__init__.py"
fi
printf '#!/bin/sh\nexec python3 $F/hermes.py --install-dir "%s" "\$@"\n' "\$dir" > "\$dir/.hermes/bin/hermes"
chmod +x "\$dir/.hermes/bin/hermes"
# Like v0.22.4: installs/<sha256(realpath(checkout))[:16]>/facts.json names the venv, and the
# venv's hermes_cli is a copy under environments/<hash>/workspace (not inside the checkout).
key=\$(python3 -c 'import hashlib, os, sys; print(hashlib.sha256(os.path.realpath(sys.argv[1]).encode()).hexdigest()[:16])' "\$dir")
env_dir="\$HOME/.hermes/installs/\$key/environments/9bfa"
venv="\$env_dir/venv/bin"
mkdir -p "\$venv" "\$env_dir/workspace"
cp -R "\$dir/hermes_cli" "\$env_dir/workspace/"
if [ -d "\$dir/websockets" ]; then cp -R "\$dir/websockets" "\$env_dir/workspace/"; fi
printf '{"packages": {"venv": {"environment": "%s"}}}\n' "\$env_dir/venv" > "\$HOME/.hermes/installs/\$key/facts.json"
printf '#!/bin/sh\nexport FAKE_VENV=new0224\nexport PYTHONPATH="%s\${PYTHONPATH:+:\$PYTHONPATH}"\nexec python3 "\$@"\n' "\$env_dir/workspace" > "\$venv/python"
chmod +x "\$venv/python"
EOF
    chmod +x "$F/install.sh"

    # Fake Emperor: GET /api/mcp/runtime/profile-defaults with a bearer token, and
    # POST /api/runtime-hosts/pair (code ABCD-EFGH; anything else is refused like the real one).
    cat >"$F/emperor.py" <<'PY'
import json, re
from http.server import BaseHTTPRequestHandler, HTTPServer
class H(BaseHTTPRequestHandler):
    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", "0"))) or b"{}")
        ok = (self.path == "/api/runtime-hosts/pair" and body.get("code") == "ABCD-EFGH"
              and re.fullmatch(r"[0-9a-f]{64}", body.get("hostFingerprint", "")) and body.get("hostname"))
        out = json.dumps({"hostId": "22222222-2222-4222-8222-222222222222", "hostToken": "ech_" + "a" * 64, "name": body.get("hostname")}
                         if ok else {"error": "Invalid or expired pairing code"}).encode()
        self.send_response(201 if ok else 400); self.send_header("content-type", "application/json"); self.end_headers(); self.wfile.write(out)
    def do_GET(self):
        if self.path != "/api/mcp/runtime/profile-defaults" or not self.headers.get("Authorization", "").startswith("Bearer test-token-"):
            self.send_response(401); self.end_headers(); return
        body = b"compression.threshold_tokens=81234\ngateway.standalone=false\napprovals.timeout=60\n"
        self.send_response(200); self.send_header("content-type", "text/plain"); self.end_headers(); self.wfile.write(body)
    def log_message(self, *a):
        pass
HTTPServer(("127.0.0.1", 18080), H).serve_forever()
PY
    nohup python3 "$F/emperor.py" >/dev/null 2>&1 &

    cat >"$F/emperor_hosts.py" <<'PY'
import asyncio, json, os, sys
from websockets.asyncio.server import serve
TOKEN = "ech_" + "a" * 64
LOG, PROFILE, REVOKE = sys.argv[1], sys.argv[2], sys.argv[3]
GO_REMOVE = os.path.join(os.path.dirname(LOG), "do-remove")
JOB = "11111111-1111-4111-8111-111111111111"
PROVISION = "33333333-3333-4333-8333-333333333333"
REMOVE_OTHER = "44444444-4444-4444-8444-444444444444"
REMOVE = "55555555-5555-4555-8555-555555555555"
AGENT = "66666666-6666-4666-8666-666666666666"
AGENT_TOKEN = "ec_" + "b" * 48
def log(frame):
    with open(LOG, "a") as f:
        f.write(json.dumps(frame) + "\n")
def process_request(conn, request):
    if request.headers.get("Authorization") != "Bearer " + TOKEN:
        return conn.respond(401, "unknown token\n")
def command(job, name, args, deadline=300):
    return json.dumps({"type": "command", "jobId": job, "command": name, "args": args, "deadlineSec": deadline})
async def removals(ws):
    while not os.path.exists(GO_REMOVE):  # the test inspects the new profile first
        await asyncio.sleep(0.2)
    # A profile of another agent (qa names its own agent id): refused, untouched.
    await ws.send(command(REMOVE_OTHER, "remove_agent", {"profile": PROFILE, "agentId": AGENT, "purge": True}))
    await ws.send(command(REMOVE, "remove_agent", {"profile": "scout", "agentId": AGENT, "purge": True}))
async def handler(ws):
    sent = False
    async for raw in ws:
        log({"raw": raw})
        frame = json.loads(raw)
        if frame["type"] == "hello" and os.path.exists(REVOKE):
            await ws.close(4401, "revoked")  # like Emperor: revocation is a close on an upgraded socket
            return
        if frame["type"] == "hello":
            await ws.send(json.dumps({"type": "welcome", "hostId": "22222222-2222-4222-8222-222222222222", "protocol": 1,
                                      "serverVersion": "test", "heartbeatSec": 30, "inventorySec": 300}))
        elif frame["type"] == "inventory" and not sent:
            sent = True
            await ws.send(command(JOB, "restart_agent", {"profile": PROFILE, "target": "bridge"}))
        elif frame["type"] == "result" and frame["jobId"] == JOB:
            # Emperor mints the agent's token when it sends the job: it travels only in this frame.
            await ws.send(command(PROVISION, "provision_agent", {
                "profile": "scout", "agentId": AGENT, "agentName": "Scout", "apiToken": AGENT_TOKEN, "gateway": "standalone",
                "llmProvider": "deepseek", "model": "deepseek-chat", "skipBrowser": True}, 1800))
        elif frame["type"] == "result" and frame["jobId"] == PROVISION:
            asyncio.create_task(removals(ws))
async def main():
    async with serve(handler, "127.0.0.1", 18091, process_request=process_request):
        await asyncio.Future()
asyncio.run(main())
PY

    # Bridge 0.9 stand-in: writes health.json per profile, then idles until SIGTERM.
    mkdir -p "$F/plugin-src"
    cp -R /repo/integrations/hermes/emperor-claw/. "$F/plugin-src/"
    rm -rf "$F/plugin-src/bridge/emperor_bridge"
    mkdir -p "$F/plugin-src/bridge/emperor_bridge"
    : >"$F/plugin-src/bridge/emperor_bridge/__init__.py"
    mkdir -p "$F/plugin-src/bridge/emperor_bridge/gateway"
    cp /repo/integrations/hermes/emperor-claw/bridge/emperor_bridge/config.py \
        /repo/integrations/hermes/emperor-claw/bridge/emperor_bridge/interfaces.py "$F/plugin-src/bridge/emperor_bridge/"
    cp /repo/integrations/hermes/emperor-claw/bridge/emperor_bridge/gateway/__init__.py \
        /repo/integrations/hermes/emperor-claw/bridge/emperor_bridge/gateway/discovery.py "$F/plugin-src/bridge/emperor_bridge/gateway/"
    echo 'BRIDGE_VERSION = "0.9.0"' >"$F/plugin-src/bridge/emperor_bridge/version.py"
    cat >"$F/plugin-src/bridge/emperor_bridge/__main__.py" <<'PY'
import json, os, signal, sys, time
from emperor_bridge.version import BRIDGE_VERSION
args = sys.argv[1:]
if args[:1] == ["healthcheck"]:
    sys.exit(0)
profiles = args[args.index("--profiles") + 1].split(",") if "--profiles" in args else [os.environ["HERMES_PROFILE"]]
for p in profiles:
    d = os.path.expanduser("~/.hermes/profiles/%s/emperor" % p)
    os.makedirs(d, exist_ok=True)
    json.dump({"bridgeVersion": BRIDGE_VERSION, "registered": True, "duplicateRuntime": False,
               "gatewayTopology": os.environ.get("EMPEROR_CLAW_HERMES_GATEWAY"), "pid": os.getpid(),
               "fakeVenv": os.environ.get("FAKE_VENV"), "checkout": os.environ.get("HERMES_CHECKOUT"),
               "profiles": profiles}, open(os.path.join(d, "health.json"), "w"))
print("fake bridge", BRIDGE_VERSION, profiles, flush=True)
signal.signal(signal.SIGTERM, lambda *a: sys.exit(0))
while True:
    time.sleep(3600)
PY
    printf 'name: emperor-claw\nversion: 0.9.0-test\n' >"$F/plugin-src/plugin.yaml"
}

write_legacy_layout() { # a 0.3 host: old checkout, hand-copied bridge, one unit per agent
    local p unit legacy="$HOME/.hermes/hermes-agent"
    mkdir -p "$legacy/hermes_cli" "$legacy/websockets" "$legacy/.hermes/bin"
    git -C "$legacy" init -q
    printf '%040d\n' 216 >"$legacy/.git/HEAD"
    : >"$legacy/hermes_cli/__init__.py"
    echo '__version__ = "12.0"' >"$legacy/websockets/__init__.py"
    mkdir -p "$HOME/.hermes/installs/old0216/environments/aaaa/venv/bin"
    printf '#!/bin/sh\nexport FAKE_VENV=old0216\nexport PYTHONPATH="%s"\nexec python3 "$@"\n' "$legacy" \
        >"$HOME/.hermes/installs/old0216/environments/aaaa/venv/bin/python"
    chmod +x "$HOME/.hermes/installs/old0216/environments/aaaa/venv/bin/python"
    printf '#!/bin/sh\nexec python3 %s/hermes.py --install-dir "%s" "$@"\n' "$F" "$legacy" >"$HOME/.local/bin/hermes"
    chmod +x "$HOME/.local/bin/hermes"
    cp "$HOME/.local/bin/hermes" "$F/legacy-launcher.orig"
    mkdir -p "$HOME/.hermes/plugins/emperor-claw"
    printf 'name: emperor-claw\nversion: 0.3.0\n' >"$HOME/.hermes/plugins/emperor-claw/plugin.yaml"
    printf 'model: fake-default\n' >"$HOME/.hermes/config.yaml"

    mkdir -p "$HOME/.hermes/emperor-bridge"
    cat >"$HOME/.hermes/emperor-bridge/emperor_hermes_bridge.py" <<'PY'
import os, time
open(os.path.expanduser("~/.hermes/legacy-ticks.log"), "a").write("start %s\n" % os.environ.get("HERMES_PROFILE"))
while True:
    time.sleep(3600)
PY
    mkdir -p "$HOME/.config/systemd/user"
    for p in viktor qa growth; do
        unit=$p
        [ "$p" = qa ] && unit=courier # the Pi's Courier runs profile qa under another unit name
        mkdir -p "$HOME/.hermes/profiles/$p/plugins/emperor-claw" "$HOME/.hermes/emperor-bridge/$p"
        printf 'model: fake\n' >"$HOME/.hermes/profiles/$p/config.yaml"
        printf 'DEEPSEEK_API_KEY="sk-fake-%s"\n' "$p" >"$HOME/.hermes/profiles/$p/.env"
        chmod 600 "$HOME/.hermes/profiles/$p/.env"
        printf 'name: emperor-claw\nversion: 0.3.0\n' >"$HOME/.hermes/profiles/$p/plugins/emperor-claw/plugin.yaml"
        python3 -c 'import sqlite3, sys
db = sqlite3.connect(sys.argv[1]); db.execute("create table sessions (id text)")
db.execute("insert into sessions values (?)", ("legacy-" + sys.argv[2],)); db.commit()' "$HOME/.hermes/profiles/$p/state.db" "$p"
        cat >"$HOME/.hermes/emperor-bridge/$p/.env" <<EOF
EMPEROR_CLAW_API_URL="http://127.0.0.1:18080"
EMPEROR_CLAW_API_TOKEN="test-token-$p"
EMPEROR_CLAW_AGENT_NAME="$p"
EMPEROR_CLAW_AGENT_ID="00000000-0000-4000-8000-00000000000${#p}"
EMPEROR_CLAW_RUNTIME_ID="hermes-$p-test-1"
EMPEROR_CLAW_HERMES_STATE_PATH="$HOME/.hermes/emperor-bridge/$p/state.json"
HERMES_BIN="$HOME/.local/bin/hermes"
HERMES_TOOLSETS="emperor-claw,web,terminal"
EOF
        cat >"$HOME/.config/systemd/user/emperor-hermes-bridge-$unit.service" <<EOF
[Unit]
Description=Emperor Claw Hermes bridge for $p (0.3)
[Service]
Type=simple
EnvironmentFile=%h/.hermes/emperor-bridge/$p/.env
Environment=HERMES_HOME=%h/.hermes/profiles/$p
Environment=HERMES_PROFILE=$p
ExecStart=/usr/bin/python3 %h/.hermes/emperor-bridge/emperor_hermes_bridge.py
Restart=always
[Install]
WantedBy=default.target
EOF
    done
    systemctl --user daemon-reload
    systemctl --user enable --now emperor-hermes-bridge-viktor emperor-hermes-bridge-courier emperor-hermes-bridge-growth >/dev/null 2>&1
}

legacy_units_active() {
    active emperor-hermes-bridge-viktor && active emperor-hermes-bridge-courier && active emperor-hermes-bridge-growth
}
legacy_units_inactive() {
    ! active emperor-hermes-bridge-viktor && ! active emperor-hermes-bridge-courier && ! active emperor-hermes-bridge-growth
}
gateway_procs() { pgrep -fc "hermes.py --install-dir .* -p $1 gateway run" || true; }
meminfo() { printf 'MemTotal: 4000000 kB\nMemAvailable: %d kB\n' $(($1 * 1024)) >"$F/meminfo-$1"; printf '%s\n' "$F/meminfo-$1"; }

inside_main() {
    export EMPEROR_HERMES_HERMES_INSTALL_SCRIPT="$HOME/fakes/install.sh"
    export EMPEROR_HERMES_READY_TIMEOUT=20
    local out bundle bundle2 big medium tiny pid pid2 out_rc key

    section "static checks"
    check "shellcheck emperor-hermes.sh" shellcheck -x /repo/integrations/hermes/install/emperor-hermes.sh
    check "shellcheck package-hermes-bridge.sh" shellcheck -x /repo/scripts/package-hermes-bridge.sh
    check "shellcheck this test" shellcheck -x -e SC2016 /repo/tests/hermes-installer.test.sh
    if ! shellcheck -x /repo/integrations/hermes/install/emperor-hermes.sh /repo/scripts/package-hermes-bridge.sh >/dev/null; then
        shellcheck -x /repo/integrations/hermes/install/emperor-hermes.sh /repo/scripts/package-hermes-bridge.sh | head -n 60 || true
    fi

    write_fakes
    write_legacy_layout
    install -m 755 /repo/integrations/hermes/install/emperor-hermes.sh "$HOME/.local/bin/emperor-hermes"
    EH=$HOME/.local/bin/emperor-hermes

    section "package"
    bundle=$(bash /repo/scripts/package-hermes-bridge.sh --plugin-dir "$F/plugin-src" --out "$F/dist")
    eq "bundle path" "$bundle" "$F/dist/emperor-hermes-bridge-0.9.0.tar.gz"
    check "bundle checksum" bash -c "cd $F/dist && sha256sum -c emperor-hermes-bridge-0.9.0.tar.gz.sha256"
    check "installer release asset" test -x "$F/dist/emperor-hermes.sh"
    out=$(tar -tzf "$bundle")
    for f in VERSION bridge/emperor_bridge/__main__.py plugin/emperor-claw/plugin.yaml systemd/emperor-hermes-gateway@.service \
        systemd/emperor-hermes-bridge@.service systemd/emperor-hermes-gateway-shared.service \
        systemd/emperor-hermes-bridge-shared.service systemd/emperor-hermes-hostd.service \
        bridge/emperor_hostd/__main__.py bridge/emperor_hostd/jobwrap.py logrotate.conf emperor-hermes.sh; do
        check "bundle has $f" grep -qx "emperor-hermes-bridge-0.9.0/$f" <<<"$out"
    done
    check_not "bundle has no caches or the 0.3 bridge" grep -Eq '__pycache__|emperor_hermes_bridge.py|plugin/emperor-claw/bridge' <<<"$out"
    sed -i 's/BRIDGE_VERSION = "0.9.0"/BRIDGE_VERSION = "0.9.1"/' "$F/plugin-src/bridge/emperor_bridge/version.py"
    bundle2=$(bash /repo/scripts/package-hermes-bridge.sh --plugin-dir "$F/plugin-src" --out "$F/dist")
    eq "second bundle" "$bundle2" "$F/dist/emperor-hermes-bridge-0.9.1.tar.gz"

    section "fake 0.3 layout"
    check "three 0.3 bridge units run" legacy_units_active

    section "doctor"
    check "doctor runs" eh doctor
    big=$(meminfo 8192)
    medium=$(meminfo 1000)
    tiny=$(meminfo 300)
    out=$(EMPEROR_HERMES_MEMINFO=$big eh doctor --plan)
    check "plan finds qa behind the courier unit" grep -q 'qa' <<<"$out"
    check "plan: standalone on a big host" grep -q '^PLAN: standalone x3' <<<"$out"
    out=$(EMPEROR_HERMES_MEMINFO=$medium eh doctor --plan)
    check "plan: shared on a Pi-sized host" grep -q '^PLAN: shared (requires --gateway shared' <<<"$out"
    out=$(EMPEROR_HERMES_MEMINFO=$tiny eh doctor --plan)
    check "plan: move when nothing fits" grep -q '^PLAN: move' <<<"$out"
    out_rc=0
    EMPEROR_HERMES_MEMINFO=$tiny eh install --profile qa --bundle "$bundle" >/dev/null 2>&1 || out_rc=$?
    check_not "install refuses when the plan says move" test "$out_rc" = 0
    check "nothing was stopped by the refused install" legacy_units_active

    section "duplicate-runtime guard"
    HERMES_PROFILE=viktor nohup python3 "$HOME/.hermes/emperor-bridge/emperor_hermes_bridge.py" >/dev/null 2>&1 &
    pid=$!
    sleep 0.5
    out_rc=0
    eh install --profile viktor --bundle "$bundle" >/dev/null 2>&1 || out_rc=$?
    check_not "install refuses while a stray 0.3 bridge serves viktor" test "$out_rc" = 0
    check "viktor's 0.3 unit was left running" active emperor-hermes-bridge-viktor
    kill "$pid"
    wait "$pid" 2>/dev/null || true

    section "install --profile qa (canary, side by side)"
    check "install qa" eh install --profile qa --bundle "$bundle" --hermes-dir "$HOME/.hermes/hermes-agent-v0.22.4"
    check "courier (qa) 0.3 unit stopped" bash -c '! systemctl --user is-active --quiet emperor-hermes-bridge-courier'
    check_not "courier (qa) 0.3 unit disabled" enabled emperor-hermes-bridge-courier
    check "courier 0.3 unit file retired" test -f "$HOME/.hermes/backups/emperor-hermes/retired-units/emperor-hermes-bridge-courier.service"
    check ".emperor-hermes-hold written in the 0.3 bridge dir" test -f "$HOME/.hermes/emperor-bridge/qa/.emperor-hermes-hold"
    check_not "courier unit gone from systemd" bash -c "systemctl --user cat emperor-hermes-bridge-courier.service"
    check "gateway@ template untouched" test -f "$HOME/.config/systemd/user/emperor-hermes-gateway@.service"
    check "bridge@ template untouched" test -f "$HOME/.config/systemd/user/emperor-hermes-bridge@.service"
    check "bridge-shared unit untouched" test -f "$HOME/.config/systemd/user/emperor-hermes-bridge-shared.service"
    check "gateway-shared unit untouched" test -f "$HOME/.config/systemd/user/emperor-hermes-gateway-shared.service"
    check "viktor 0.3 unit untouched" active emperor-hermes-bridge-viktor
    check "growth 0.3 unit untouched" active emperor-hermes-bridge-growth
    check "gateway@qa active" active emperor-hermes-gateway@qa
    check "bridge@qa active" active emperor-hermes-bridge@qa
    eq "host.env launcher" "$(sed -n 's/^HERMES_LAUNCHER="\(.*\)"/\1/p' "$HOME/.config/emperor-hermes/host.env")" "$HOME/.hermes/hermes-agent-v0.22.4/.hermes/bin/hermes"
    eq "host.env python" "$(sed -n 's/^HERMES_PYTHON="\(.*\)"/\1/p' "$HOME/.config/emperor-hermes/host.env")" "$HOME/.local/share/emperor-hermes/python"
    key=$(python3 -c 'import hashlib, os, sys; print(hashlib.sha256(os.path.realpath(sys.argv[1]).encode()).hexdigest()[:16])' "$HOME/.hermes/hermes-agent-v0.22.4")
    check "facts.json where Hermes keys the checkout" test -f "$HOME/.hermes/installs/$key/facts.json"
    check_not "stable python is not a symlink" test -L "$HOME/.local/share/emperor-hermes/python"
    eq "stable python wraps the venv named by facts.json" "$(sed -n 2p "$HOME/.local/share/emperor-hermes/python")" \
        "exec \"$HOME/.hermes/installs/$key/environments/9bfa/venv/bin/python\" \"\$@\""
    check "wrapper runs the venv (websockets importable)" "$HOME/.local/share/emperor-hermes/python" -c 'import websockets, hermes_cli'
    check "status names the venv python" bash -c "\"$EH\" status --profile qa | grep -q 'venv/bin/python'"
    check "local bin hermes untouched until finalize" cmp "$HOME/.local/bin/hermes" "$F/legacy-launcher.orig"
    check "Hermes install flags" grep -q 'install v0.22.4 .*hermes-agent-v0.22.4 --skip-setup --skip-computer-use --skip-browser' "$HOME/.hermes/fake-install.log"
    check "state.db backed up" sqlite_has "$HOME/.hermes/backups/emperor-hermes/qa/state.db.pre-v0.22" legacy-qa
    check "plugin 0.9 in qa" contains "$HOME/.hermes/profiles/qa/plugins/emperor-claw/plugin.yaml" "0.9.0-test"
    check "0.3 plugin backed up" contains "$HOME/.hermes/backups/emperor-hermes/qa/plugin.pre-0.9/plugin.yaml" "0.3.0"
    check "global plugin untouched while 0.3 bridges run" contains "$HOME/.hermes/plugins/emperor-claw/plugin.yaml" "0.3.0"
    check "token merged into the profile .env" contains "$HOME/.hermes/profiles/qa/.env" 'EMPEROR_CLAW_API_TOKEN="test-token-qa"'
    check "toolsets renamed" contains "$HOME/.hermes/profiles/qa/.env" 'EMPEROR_CLAW_HERMES_TOOLSETS="emperor-claw,web,terminal"'
    check_not "HERMES_BIN not merged" contains "$HOME/.hermes/profiles/qa/.env" HERMES_BIN
    eq "profile .env stays private" "$(stat -c %a "$HOME/.hermes/profiles/qa/.env")" 600
    check "standalone keys via the pinned launcher" contains "$HOME/.hermes/fake-hermes.log" "qa config set gateway.standalone=true via 0.22.4"
    check "idle exit off" contains "$HOME/.hermes/fake-hermes.log" "qa config set gateway.unmanaged_idle_exit_seconds=0 via 0.22.4"
    check "drain timeout" contains "$HOME/.hermes/fake-hermes.log" "qa config set agent.restart_drain_timeout=30 via 0.22.4"
    check "clarify timeout" contains "$HOME/.hermes/fake-hermes.log" "qa config set agent.clarify_timeout=60 via 0.22.4"
    check "gateway stop timeout exceeds the drain" contains "$HOME/.config/systemd/user/emperor-hermes-gateway@.service" "TimeoutStopSec=70"
    check "client_env passthrough" contains "$HOME/.hermes/fake-hermes.log" 'qa config set terminal.client_env_passthrough=["EMPEROR_THREAD_ID","EMPEROR_THREAD_TYPE","EMPEROR_SESSION_GEN","EMPEROR_AGENT_ID","EMPEROR_PROFILE_HOME"]'
    check "defaults fetched from Emperor" contains "$HOME/.hermes/fake-hermes.log" "qa config set compression.threshold_tokens=81234"
    check_not "server gateway.* keys ignored" contains "$HOME/.hermes/fake-hermes.log" "qa config set gateway.standalone=false"
    check "plugin enabled" contains "$HOME/.hermes/fake-hermes.log" "qa plugins enable emperor-claw via 0.22.4"
    eq "bridge topology" "$(json_get "$HOME/.hermes/profiles/qa/emperor/health.json" gatewayTopology)" standalone
    eq "bridge runs on the Hermes venv" "$(json_get "$HOME/.hermes/profiles/qa/emperor/health.json" fakeVenv)" new0224
    eq "bridge sees HERMES_CHECKOUT" "$(json_get "$HOME/.hermes/profiles/qa/emperor/health.json" checkout)" "$HOME/.hermes/hermes-agent-v0.22.4"
    if out=$(eh status --profile qa); then ok "status --profile qa exits 0"; else bad "status --profile qa exits 0"; fi
    check "status shows a ready 0.22.4 gateway" grep -q 'ready 0.22.4' <<<"$out"
    check "status says the 0.3 unit is retired" grep -q '0.3 unit emperor-hermes-bridge-courier.service: retired' <<<"$out"
    check "logrotate timer enabled" enabled emperor-hermes-logrotate.timer
    check "logrotate config points at this home" contains "$HOME/.config/emperor-hermes/logrotate.conf" "$HOME/.hermes/profiles/*/bridge.log"
    check "logrotate config parses" logrotate -d -s "$F/lr.state" "$HOME/.config/emperor-hermes/logrotate.conf"
    check "systemd-analyze verify units" systemd-analyze --user verify emperor-hermes-gateway@qa.service emperor-hermes-bridge@qa.service \
        emperor-hermes-gateway-shared.service emperor-hermes-bridge-shared.service

    section "idempotent re-run"
    python3 -c 'import sqlite3, sys; db = sqlite3.connect(sys.argv[1]); db.execute("insert into sessions values (?)", ("after-v022",)); db.commit()' "$HOME/.hermes/profiles/qa/state.db"
    check "install qa again" eh install --profile qa --bundle "$bundle"
    check_not "first backup kept (no post-0.22 rows)" sqlite_has "$HOME/.hermes/backups/emperor-hermes/qa/state.db.pre-v0.22" after-v022
    eq "Hermes installed once" "$(grep -c '^install ' "$HOME/.hermes/fake-install.log")" 1
    eq "one gateway process for qa" "$(gateway_procs qa)" 1
    eq "one plugin dir" "$(find "$HOME/.hermes/profiles/qa/plugins" -maxdepth 1 -name 'emperor-claw*' | wc -l)" 1

    section "migrate --all (standalone)"
    check "migrate --all" eh migrate --all --bundle "$bundle"
    check "every 0.3 unit stopped" legacy_units_inactive
    for p in viktor qa growth; do
        check "gateway@$p + bridge@$p active" bash -c "systemctl --user is-active --quiet emperor-hermes-gateway@$p && systemctl --user is-active --quiet emperor-hermes-bridge@$p"
    done
    check "status ok" eh status
    check "global plugin updated once no 0.3 bridge runs" contains "$HOME/.hermes/plugins/emperor-claw/plugin.yaml" "0.9.0-test"

    section "update"
    pid=$(mainpid emperor-hermes-bridge@qa)
    pid2=$(mainpid emperor-hermes-gateway@qa)
    check "update to 0.9.1" eh update --bundle "$bundle2"
    eq "current -> 0.9.1" "$(readlink "$HOME/.hermes/emperor-bridge/current")" releases/0.9.1
    check_not "bridge restarted" test "$(mainpid emperor-hermes-bridge@qa)" = "$pid"
    eq "gateway kept (Hermes unchanged)" "$(mainpid emperor-hermes-gateway@qa)" "$pid2"
    sleep 1
    eq "bridge reports 0.9.1" "$(json_get "$HOME/.hermes/profiles/qa/emperor/health.json" bridgeVersion)" 0.9.1
    check "rollback --bridge-only" eh rollback --bridge-only
    eq "current -> 0.9.0" "$(readlink "$HOME/.hermes/emperor-bridge/current")" releases/0.9.0

    section "restart-gateway"
    pid=$(mainpid emperor-hermes-gateway@qa)
    mkdir -p "$HOME/.hermes/profiles/qa/emperor"
    echo '{"version":2,"turns":{"emp-1":{"status":"running"}}}' >"$HOME/.hermes/profiles/qa/emperor/bridge-state.json"
    out_rc=0
    eh restart-gateway --profile qa --when-idle --timeout 6 >/dev/null 2>&1 || out_rc=$?
    check_not "--when-idle waits while a turn runs" test "$out_rc" = 0
    eq "gateway not restarted while busy" "$(mainpid emperor-hermes-gateway@qa)" "$pid"
    echo '{"version":2,"turns":{"emp-1":{"status":"delivered"}}}' >"$HOME/.hermes/profiles/qa/emperor/bridge-state.json"
    check "restart-gateway --when-idle when idle" eh restart-gateway --profile qa --when-idle --timeout 30
    check_not "gateway restarted" test "$(mainpid emperor-hermes-gateway@qa)" = "$pid"

    section "rollback --all"
    check "rollback --all" eh rollback --all
    check "0.3 units back" legacy_units_active
    for p in viktor qa growth; do
        check_not "gateway@$p stopped" active "emperor-hermes-gateway@$p"
        check_not "bridge@$p stopped" active "emperor-hermes-bridge@$p"
    done
    check_not "qa state.db restored (no post-0.22 rows)" sqlite_has "$HOME/.hermes/profiles/qa/state.db" after-v022
    check "qa state.db has the 0.3 session" sqlite_has "$HOME/.hermes/profiles/qa/state.db" legacy-qa
    check "0.22 state.db kept aside" bash -c "ls $HOME/.hermes/profiles/qa/state.db.v0.22-rollback-*"
    check "qa plugin back to 0.3" contains "$HOME/.hermes/profiles/qa/plugins/emperor-claw/plugin.yaml" "0.3.0"
    check_not "qa .env restored" contains "$HOME/.hermes/profiles/qa/.env" EMPEROR_CLAW_API_TOKEN
    check "global plugin back to 0.3" contains "$HOME/.hermes/plugins/emperor-claw/plugin.yaml" "0.3.0"
    check_not "status reports rolled-back profiles" eh status
    check_not "cycle-1 backups retired" test -d "$HOME/.hermes/backups/emperor-hermes/qa"
    check "cycle-1 backups kept as rolled-back" bash -c "ls -d $HOME/.hermes/backups/emperor-hermes/qa.rolled-back-*"
    check "0.3 units re-enabled as they were" bash -c 'systemctl --user is-enabled --quiet emperor-hermes-bridge-courier && systemctl --user is-enabled --quiet emperor-hermes-bridge-growth'

    section "second cycle prep: newer profile state, a disabled 0.3 unit, a foreign gateway"
    printf 'CYCLE_MARK="2"\n' >>"$HOME/.hermes/profiles/qa/.env"
    python3 -c 'import sqlite3, sys; db = sqlite3.connect(sys.argv[1]); db.execute("insert into sessions values (?)", ("cycle2",)); db.commit()' "$HOME/.hermes/profiles/qa/state.db"
    systemctl --user disable emperor-hermes-bridge-growth >/dev/null 2>&1
    cat >"$HOME/.config/systemd/user/hermes-gateway-viktor.service" <<EOF
[Unit]
Description=Owner's own Hermes messaging gateway for viktor (not ours)
[Service]
ExecStart=$HOME/.local/bin/hermes -p viktor gateway run
SuccessExitStatus=1
[Install]
WantedBy=default.target
EOF
    systemctl --user daemon-reload
    systemctl --user enable --now hermes-gateway-viktor.service >/dev/null 2>&1
    check "foreign gateway runs" active hermes-gateway-viktor
    out=$(eh doctor)
    check "doctor reports the foreign gateway" grep -q 'unit hermes-gateway-viktor.service' <<<"$out"

    section "migrate --all --gateway shared (Pi)"
    out_rc=0
    EMPEROR_HERMES_MEMINFO=$medium eh migrate --all --gateway shared --bundle "$bundle" </dev/null >/dev/null 2>&1 || out_rc=$?
    check_not "shared needs the trade-off confirmed" test "$out_rc" = 0
    check "0.3 units still running" legacy_units_active
    out_rc=0
    out=$(EMPEROR_HERMES_MEMINFO=$medium eh migrate --all --gateway shared --bundle "$bundle" --yes 2>&1) || out_rc=$?
    check_not "migrate refuses next to a gateway it did not start" test "$out_rc" = 0
    check "refusal names --take-over-gateway" grep -q 'take-over-gateway' <<<"$out"
    check "foreign gateway untouched" active hermes-gateway-viktor
    check "0.3 units untouched by the refusal" legacy_units_active
    if out=$(EMPEROR_HERMES_MEMINFO=$medium eh migrate --all --gateway shared --bundle "$bundle" --yes --max-parallel 1 --take-over-gateway 2>&1); then
        ok "migrate --all --gateway shared --yes"
    else
        bad "migrate --all --gateway shared --yes"
        printf '%s\n' "$out" | tail -n 20
    fi
    check "trade-off shown" grep -q 'Shared gateway trade-off' <<<"$out"
    check_not "foreign gateway stopped on take-over" active hermes-gateway-viktor
    check_not "foreign gateway disabled on take-over" enabled hermes-gateway-viktor
    check "fresh cycle-2 backup of .env" contains "$HOME/.hermes/backups/emperor-hermes/qa/env.pre-0.9" 'CYCLE_MARK="2"'
    check "fresh cycle-2 backup of state.db" sqlite_has "$HOME/.hermes/backups/emperor-hermes/qa/state.db.pre-v0.22" cycle2
    check "0.3 units stopped" legacy_units_inactive
    check "gateway-shared active" active emperor-hermes-gateway-shared
    check "bridge-shared active" active emperor-hermes-bridge-shared
    out=$(sed -n 's/^EMPEROR_HERMES_PROFILES="\(.*\)"/\1/p' "$HOME/.config/emperor-hermes/host.env")
    eq "shared profile list" "$(tr ',' '\n' <<<"$out" | sort | tr '\n' ' ')" "growth qa viktor "
    for p in viktor qa growth; do
        check_not "no standalone units for $p" active "emperor-hermes-gateway@$p"
        check "$p gateway.standalone=false" contains "$HOME/.hermes/profiles/$p/config.yaml" "# set gateway.standalone=false"
        check "$p max parallel 1" contains "$HOME/.hermes/profiles/$p/.env" 'EMPEROR_CLAW_HERMES_MAX_PARALLEL_TURNS="1"'
        eq "$p served by the shared bridge" "$(json_get "$HOME/.hermes/profiles/$p/emperor/health.json" gatewayTopology)" shared
    done
    check "default home multiplexes" contains "$HOME/.hermes/fake-hermes.log" "default config set gateway.multiplex_profiles=true via 0.22.4"
    check "default home config backed up" test -f "$HOME/.hermes/backups/emperor-hermes/host/config.yaml.pre-0.9"
    if out=$(eh status); then ok "status ok (shared)"; else bad "status ok (shared)"; fi
    check "shared gateway serves the profiles" grep -q "profiles/viktor" <<<"$out"
    out=$(eh doctor --measure)
    check "measure lists the shared gateway" grep -q 'emperor-hermes-gateway-shared.service' <<<"$out"
    check "measure prints the R-1 gate" grep -q '^R-1 item 1: shared gateway .* PASS' <<<"$out"
    check "measurement recorded" test -s "$HOME/.local/share/emperor-hermes/measurements.jsonl"
    pid=$(mainpid emperor-hermes-gateway-shared)
    check "restart-gateway --shared --when-idle" eh restart-gateway --shared --when-idle --timeout 30
    check_not "shared gateway restarted" test "$(mainpid emperor-hermes-gateway-shared)" = "$pid"

    section "switch growth back to standalone"
    check "install --profile growth --gateway standalone" eh install --profile growth --gateway standalone --bundle "$bundle"
    check "gateway@growth active" active emperor-hermes-gateway@growth
    check "bridge@growth active" active emperor-hermes-bridge@growth
    out=$(sed -n 's/^EMPEROR_HERMES_PROFILES="\(.*\)"/\1/p' "$HOME/.config/emperor-hermes/host.env")
    eq "growth left the shared list" "$(tr ',' '\n' <<<"$out" | sort | tr '\n' ' ')" "qa viktor "
    check "shared units still run for the others" bash -c 'systemctl --user is-active --quiet emperor-hermes-gateway-shared && systemctl --user is-active --quiet emperor-hermes-bridge-shared'
    sleep 1
    eq "shared bridge no longer hosts growth" "$(json_get "$HOME/.hermes/profiles/qa/emperor/health.json" profiles | tr -d "[]' ")" "$(tr -d ' ' <<<"$out")"
    check "status ok (mixed)" eh status

    section "finalize"
    check "finalize" eh finalize
    eq "local bin hermes -> v0.22.4 launcher" "$(readlink "$HOME/.local/bin/hermes")" "$HOME/.hermes/hermes-agent-v0.22.4/.hermes/bin/hermes"
    check_not "0.3 unit files retired" test -e "$HOME/.config/systemd/user/emperor-hermes-bridge-courier.service"
    check "0.3 unit file kept in retired-units" test -f "$HOME/.hermes/backups/emperor-hermes/retired-units/emperor-hermes-bridge-courier.service"
    check_not "old checkout moved away" test -d "$HOME/.hermes/hermes-agent"
    check "old checkout archived" test -d "$HOME/.hermes/backups/emperor-hermes/host/hermes-agent-legacy"
    check_not "0.3 bridge file retired" test -e "$HOME/.hermes/emperor-bridge/emperor_hermes_bridge.py"
    check "status ok after finalize" eh status

    section "rollback after finalize"
    check "rollback --all" eh rollback --all
    check "old checkout restored" test -d "$HOME/.hermes/hermes-agent/.git"
    check "local bin hermes restored" cmp "$HOME/.local/bin/hermes" "$F/legacy-launcher.orig"
    check "0.3 units restored and running" legacy_units_active
    check_not "shared gateway stopped" active emperor-hermes-gateway-shared
    check_not "shared bridge stopped" active emperor-hermes-bridge-shared
    check_not "gateway@growth stopped" active emperor-hermes-gateway@growth
    check "default home config restored" bash -c "cmp $HOME/.hermes/config.yaml $HOME/.hermes/backups/emperor-hermes/host/config.yaml.pre-0.9.rolled-back-*"
    check_not "default home backup retired" test -e "$HOME/.hermes/backups/emperor-hermes/host/config.yaml.pre-0.9"
    check "qa .env restored from the cycle-2 backup" contains "$HOME/.hermes/profiles/qa/.env" 'CYCLE_MARK="2"'
    check "qa state.db restored from the cycle-2 backup" sqlite_has "$HOME/.hermes/profiles/qa/state.db" cycle2
    check "growth 0.3 unit running again" active emperor-hermes-bridge-growth
    check_not "growth 0.3 unit stays disabled as before migration" enabled emperor-hermes-bridge-growth
    check "viktor 0.3 unit enabled as before" enabled emperor-hermes-bridge-viktor
    check "foreign gateway restored (enabled)" enabled hermes-gateway-viktor
    check "foreign gateway restored (running)" active hermes-gateway-viktor
    # shellcheck disable=SC2016 # the pattern is the literal ${HERMES_SHA} text the installer must contain
    check "Hermes install.sh fetched by the pinned commit" grep -q 'hermes-agent/${HERMES_SHA}/scripts/install.sh' "$EH"
    eq "no temp dirs leaked" "$(find "${TMPDIR:-/tmp}" -maxdepth 1 -name 'emperor-hermes.*' | wc -l)" 0
    eq "no 0.9 unit left running" "$(systemctl --user list-units --state=active --no-legend --plain 'emperor-hermes-gateway*' 'emperor-hermes-bridge@*' 'emperor-hermes-bridge-shared*' | wc -l)" 0

    section "self-made bridge watchdogs"
    cat >"$F/bridge_watchdog.py" <<'PY'
import subprocess, time
while True:
    subprocess.run(["systemctl", "--user", "enable", "--now", "emperor-hermes-bridge-courier.service"])
    time.sleep(300)
PY
    cat >"$HOME/.config/systemd/user/bridge-watchdog.service" <<EOF
[Unit]
Description=Agent-made bridge watchdog (0.3)
[Service]
Type=simple
ExecStart=/usr/bin/python3 $F/bridge_watchdog.py
Restart=always
[Install]
WantedBy=default.target
EOF
    cat >"$HOME/.config/systemd/user/bridge-watchdog.timer" <<EOF
[Unit]
Description=Agent-made bridge watchdog timer (0.3)
[Timer]
OnCalendar=*:0/5
Persistent=true
Unit=bridge-watchdog.service
[Install]
WantedBy=timers.target
EOF
    crontab - <<EOF
*/5 * * * * systemctl --user restart emperor-hermes-bridge-courier.service
EOF
    systemctl --user daemon-reload
    systemctl --user enable --now bridge-watchdog.service bridge-watchdog.timer >/dev/null 2>&1
    check "watchdog service runs" active bridge-watchdog
    check "watchdog timer runs" active bridge-watchdog.timer
    out_rc=0
    out=$(eh install --profile qa --gateway standalone --bundle "$bundle" 2>&1) || out_rc=$?
    check_not "install refuses while a watchdog is present" test "$out_rc" = 0
    check "refusal names --disable-watchdogs" grep -q -- '--disable-watchdogs' <<<"$out"
    check "watchdog service still enabled after the refusal" enabled bridge-watchdog.service
    check "0.3 units untouched by the refusal" legacy_units_active
    check "cron line untouched by the refusal" bash -c "crontab -l | grep -q 'emperor-hermes-bridge-courier'"

    check "install with --disable-watchdogs" eh install --profile qa --gateway standalone --bundle "$bundle" --disable-watchdogs
    check_not "watchdog service stopped" active bridge-watchdog
    check_not "watchdog service disabled" enabled bridge-watchdog.service
    check_not "watchdog timer stopped" active bridge-watchdog.timer
    check_not "watchdog timer disabled" enabled bridge-watchdog.timer
    check "cron line commented out" bash -c "crontab -l | grep -q '^# disabled by emperor-hermes: .*emperor-hermes-bridge-courier'"
    check_not "no active cron watchdog line remains" bash -c "crontab -l | grep -v '^#' | grep -q 'emperor-hermes-bridge-courier'"
    check "courier 0.3 unit retired" test -f "$HOME/.hermes/backups/emperor-hermes/retired-units/emperor-hermes-bridge-courier.service"
    check ".emperor-hermes-hold written" test -f "$HOME/.hermes/emperor-bridge/qa/.emperor-hermes-hold"
    (crontab -l 2>/dev/null; printf '0 3 * * * echo added-after-migration\n') | crontab -
    check "user adds a cron line after migration" bash -c "crontab -l | grep -q 'added-after-migration'"

    check "rollback --all re-enables the watchdog" eh rollback --all
    check "watchdog service re-enabled" enabled bridge-watchdog.service
    check "watchdog timer re-enabled" enabled bridge-watchdog.timer
    check "cron line restored" bash -c "crontab -l | grep -q 'emperor-hermes-bridge-courier'"
    check_not "cron line no longer commented" bash -c "crontab -l | grep -q '^# disabled by emperor-hermes'"
    check "user's new cron line survives rollback" bash -c "crontab -l | grep -q 'added-after-migration'"
    check "courier 0.3 unit file restored" test -f "$HOME/.config/systemd/user/emperor-hermes-bridge-courier.service"
    check_not ".emperor-hermes-hold removed" test -e "$HOME/.hermes/emperor-bridge/qa/.emperor-hermes-hold"
    check "courier 0.3 unit running again" active emperor-hermes-bridge-courier
    crontab -r 2>/dev/null || true
    systemctl --user disable --now bridge-watchdog.service bridge-watchdog.timer >/dev/null 2>&1 || true
    rm -f "$HOME/.config/systemd/user/bridge-watchdog.service" "$HOME/.config/systemd/user/bridge-watchdog.timer"
    systemctl --user daemon-reload

    section "safe crontab rewrite"
    crontab - <<'EOF'
*/5 * * * * systemctl --user restart emperor-hermes-bridge-courier.service
EOF
    mkdir -p "$F/bin"
    cat >"$F/bin/crontab" <<'EOF'
#!/usr/bin/env bash
if [ "$1" = "-l" ]; then
    /usr/bin/crontab -l 2>/dev/null || true
    exit 0
fi
echo "crontab: cannot write the new crontab (fake failure)" >&2
exit 1
EOF
    chmod +x "$F/bin/crontab"
    out_rc=0
    out=$(PATH="$F/bin:$PATH" eh install --profile qa --gateway standalone --bundle "$bundle" --disable-watchdogs 2>&1) || out_rc=$?
    check_not "install dies when the crontab write fails" test "$out_rc" = 0
    check "the failure names the crontab write" grep -q 'cannot write the new crontab' <<<"$out"
    check "0.3 units untouched by the failed crontab write" legacy_units_active
    check "the live crontab is unchanged" bash -c "crontab -l | grep -q 'emperor-hermes-bridge-courier'"
    crontab -r 2>/dev/null || true
    sed -i '/^watchdog_crontab=/d' "$HOME/.local/share/emperor-hermes/host.state" 2>/dev/null || true

    section "static service watchdogs (TriggeredBy) and hold handling"
    mkdir -p "$HOME/.hermes/emperor-bridge/qa"
    printf 'pre-existing user file, not ours\n' >"$HOME/.hermes/emperor-bridge/qa/.emperor-hermes-hold"
    cat >"$HOME/.config/systemd/user/static-bridge-watchdog.service" <<EOF
[Unit]
Description=Static bridge watchdog (0.3)
[Service]
Type=oneshot
ExecStart=/usr/bin/python3 $F/bridge_watchdog.py
EOF
    cat >"$HOME/.config/systemd/user/static-bridge-watchdog.timer" <<'EOF'
[Unit]
Description=Static bridge watchdog timer
[Timer]
OnCalendar=*:0/7
Unit=static-bridge-watchdog.service
[Install]
WantedBy=timers.target
EOF
    systemctl --user daemon-reload
    systemctl --user enable --now static-bridge-watchdog.timer >/dev/null 2>&1
    out=$(eh doctor)
    check "static service flagged while its timer is enabled" grep -q 'static-bridge-watchdog.service' <<<"$out"
    check "install --disable-watchdogs disables the static timer" eh install --profile qa --gateway standalone --bundle "$bundle" --disable-watchdogs
    check_not "static watchdog timer disabled" enabled static-bridge-watchdog.timer
    check_not "static watchdog timer stopped" active static-bridge-watchdog.timer
    check "pre-existing hold not overwritten" bash -c "grep -q 'pre-existing user file' '$HOME/.hermes/emperor-bridge/qa/.emperor-hermes-hold'"
    out=$(eh doctor)
    check_not "static service not flagged after its timer is disabled" grep -q 'static-bridge-watchdog.service' <<<"$out"
    check "rollback restores the static watchdog timer" eh rollback --all
    check "static watchdog timer re-enabled" enabled static-bridge-watchdog.timer
    check "non-marker hold not removed on rollback" bash -c "test -f '$HOME/.hermes/emperor-bridge/qa/.emperor-hermes-hold' && grep -q 'pre-existing user file' '$HOME/.hermes/emperor-bridge/qa/.emperor-hermes-hold'"
    systemctl --user disable --now static-bridge-watchdog.timer >/dev/null 2>&1 || true
    rm -f "$HOME/.config/systemd/user/static-bridge-watchdog.service" "$HOME/.config/systemd/user/static-bridge-watchdog.timer"
    systemctl --user daemon-reload
    rm -f "$HOME/.hermes/emperor-bridge/qa/.emperor-hermes-hold"

    section "watchdog detection refinements"
    crontab - <<'EOF'
*/5 * * * * systemctl --user status emperor-hermes-bridge-qa.service
EOF
    cat >"$HOME/.config/systemd/user/hermes-status.service" <<EOF
[Unit]
Description=Hermes status check (not a watchdog)
[Service]
ExecStart=$HOME/.local/bin/emperor-hermes status
[Install]
WantedBy=default.target
EOF
    systemctl --user daemon-reload
    systemctl --user enable hermes-status.service >/dev/null 2>&1
    out=$(eh doctor)
    check_not "read-only status cron is not flagged" grep -q 'systemctl --user status emperor-hermes-bridge-qa' <<<"$out"
    check_not "installer status unit is not flagged" grep -q 'hermes-status.service' <<<"$out"
    crontab - <<'EOF'
*/5 * * * * systemctl --user restart emperor-hermes-bridge-qa.service
EOF
    out=$(eh doctor)
    check "restart cron is flagged" grep -q 'systemctl --user restart emperor-hermes-bridge-qa' <<<"$out"
    crontab -r 2>/dev/null || true
    systemctl --user disable hermes-status.service >/dev/null 2>&1 || true
    rm -f "$HOME/.config/systemd/user/hermes-status.service"
    systemctl --user daemon-reload

    mkdir -p "$HOME/.hermes/profiles/builder/scripts"
    cat >"$HOME/.hermes/profiles/builder/scripts/w.py" <<'PY'
#!/usr/bin/env python3
# would run: systemctl --user restart emperor-hermes-bridge-qa.service
pass
PY
    chmod +x "$HOME/.hermes/profiles/builder/scripts/w.py"
    cat >"$HOME/.config/systemd/user/builder-watchdog.service" <<'EOF'
[Unit]
Description=Builder watchdog
[Service]
ExecStart=/usr/bin/python3 %h/.hermes/profiles/builder/scripts/w.py
[Install]
WantedBy=default.target
EOF
    systemctl --user daemon-reload
    systemctl --user enable builder-watchdog.service >/dev/null 2>&1
    out=$(eh doctor)
    check "%h ExecStart path is detected" grep -q 'builder-watchdog.service' <<<"$out"
    systemctl --user disable builder-watchdog.service >/dev/null 2>&1 || true
    rm -f "$HOME/.config/systemd/user/builder-watchdog.service"
    systemctl --user daemon-reload
    rm -rf "$HOME/.hermes/profiles/builder"

    mkdir -p "$F/globs"
    : >"$F/globs/a"
    : >"$F/globs/b"
    crontab - <<'EOF'
* * * * * systemctl --user restart emperor-hermes-bridge-qa.service
EOF
    out=$(cd "$F/globs" && eh doctor 2>&1)
    check "a '* * * * *' cron is detected in a directory with files" grep -q 'restart emperor-hermes-bridge-qa.service' <<<"$out"
    crontab -r 2>/dev/null || true
    rm -rf "$F/globs"

    section "status --json, non-interactive install, remove"
    out_rc=0
    eh install --profile qa --non-interactive --bundle "$bundle" >/dev/null 2>&1 || out_rc=$?
    check_not "--non-interactive install refuses without --gateway" test "$out_rc" = 0
    check "non-interactive install (pre-written .env, explicit gateway)" eh install --profile qa --gateway standalone --non-interactive --bundle "$bundle"
    check "gateway@qa + bridge@qa active" bash -c "systemctl --user is-active --quiet emperor-hermes-gateway@qa && systemctl --user is-active --quiet emperor-hermes-bridge@qa"
    out_rc=0
    eh status --json --profile qa >"$F/status.json" || out_rc=$?
    eq "status --json exit" "$out_rc" 0
    eq "status --json content" "$(python3 -c 'import json, sys
d = json.load(open(sys.argv[1])); p = d["profiles"][0]
print(d["ok"], p["profile"], p["topology"], p["gateway"], p["bridge"], d["hermes"]["pinned"], d["hostDaemon"]["connected"])' "$F/status.json")" \
        "True qa standalone active active True False"

    section "host connect (runtime host daemon) and a restart job"
    nohup python3 "$F/emperor_hosts.py" "$F/hostd-frames.jsonl" qa "$F/revoke" >"$F/emperor_hosts.log" 2>&1 &
    sleep 1
    out_rc=0
    eh host connect --url http://127.0.0.1:18080 ZZZZ-ZZZZ --bundle "$bundle" >/dev/null 2>&1 || out_rc=$?
    check_not "a wrong pairing code is refused" test "$out_rc" = 0
    out_rc=0
    out=$(eh host connect --url http://emperor.example.com ABCD-EFGH --bundle "$bundle" 2>&1) || out_rc=$?
    check_not "plain http to a public address is refused" test "$out_rc" = 0
    check "the refusal names --insecure" grep -q -- '--insecure' <<<"$out"
    out_rc=0
    eh host connect --url http://10.evil.com ABCD-EFGH --bundle "$bundle" >/dev/null 2>&1 || out_rc=$?
    check_not "a name that only looks private is refused" test "$out_rc" = 0
    check_not "no hostd.env after a refused code" test -e "$HOME/.config/emperor-hermes/hostd.env"
    # A bundle of the installer's own version: a profile installed by a provision job reuses it (no download).
    bundle_cur=$(bash /repo/scripts/package-hermes-bridge.sh --plugin-dir "$F/plugin-src" --out "$F/dist-cur" \
        --version "$(sed -n 's/^readonly EMPEROR_HERMES_VERSION="\(.*\)"/\1/p' "$EH")")
    check "host connect" eh host connect --url http://127.0.0.1:18080 ABCD-EFGH --bundle "$bundle_cur"
    eq "hostd.env is private" "$(stat -c %a "$HOME/.config/emperor-hermes/hostd.env")" 600
    check "hostd.env holds the host token" contains "$HOME/.config/emperor-hermes/hostd.env" 'HOST_TOKEN="ech_'
    check "hostd unit enabled" enabled emperor-hermes-hostd.service
    check "systemd-analyze verify hostd unit" systemd-analyze --user verify emperor-hermes-hostd.service
    # The fake serves the socket on another port (websockets cannot serve the POST); point the daemon there.
    sed -i 's#^EMPEROR_URL=.*#EMPEROR_URL="http://127.0.0.1:18091"#' "$HOME/.config/emperor-hermes/hostd.env"
    pid=$(mainpid emperor-hermes-bridge@qa)
    systemctl --user restart emperor-hermes-hostd.service
    for _ in $(seq 1 60); do
        grep -q '\\"type\\": *\\"result\\"\|"type":"result"' "$F/hostd-frames.jsonl" 2>/dev/null && break
        sleep 0.5
    done
    check "hostd active" active emperor-hermes-hostd.service
    frames() { python3 -c 'import json, sys
for line in open(sys.argv[1]):
    print(json.loads(json.loads(line)["raw"])["type"])' "$F/hostd-frames.jsonl" 2>/dev/null | tr '\n' ' '; }
    out=$(frames)
    check "hello, inventory, ack, progress, result" bash -c "grep -q 'hello inventory' <<<'$out' && grep -q 'ack' <<<'$out' && grep -q 'result' <<<'$out'"
    eq "frame checks" "$(python3 -c 'import json, re, sys
fr = [json.loads(json.loads(l)["raw"]) for l in open(sys.argv[1])]
by = {}
for f in fr:
    by.setdefault(f["type"], []).append(f)
hello, inv, ack, res = by["hello"][0], by["inventory"][0], by["ack"][0], by["result"][0]
qa = [p for p in inv["profiles"] if p["profile"] == "qa"][0]
print(bool(re.fullmatch(r"[0-9a-f]{64}", hello["hostFingerprint"])), hello["installerVersion"] is not None,
      qa["agentId"], qa["sameEmperor"], "deepseek" in inv["llmProviders"], ack["accepted"], res["ok"], res["exitCode"], res.get("units"))' "$F/hostd-frames.jsonl")" \
        "True True 00000000-0000-4000-8000-000000000002 False True True True 0 ['emperor-hermes-bridge@qa.service']"
    check_not "bridge@qa restarted by the job" test "$(mainpid emperor-hermes-bridge@qa)" = "$pid"
    check "job log kept" test -f "$HOME/.local/share/emperor-hermes/jobs/11111111-1111-4111-8111-111111111111.log"
    check_not "no LLM key in any frame" grep -q 'sk-fake-' "$F/hostd-frames.jsonl"
    check_not "no agent token in any frame" grep -q 'test-token-' "$F/hostd-frames.jsonl"
    check_not "no host token in any frame" grep -q "ech_aaaa" "$F/hostd-frames.jsonl"
    check "host status" eh host status
    check "jobs dir is private" bash -c "[ \"\$(stat -c %a $HOME/.local/share/emperor-hermes/jobs)\" = 700 ]"

    section "provision_agent and remove_agent jobs (host daemon 0.22)"
    jobframe() { # jobId type -> that frame as JSON ("" when not there yet)
        python3 -c 'import json, sys
for line in open(sys.argv[1]):
    f = json.loads(json.loads(line)["raw"])
    if f.get("jobId") == sys.argv[2] and f["type"] == sys.argv[3]:
        print(json.dumps(f)); break' "$F/hostd-frames.jsonl" "$1" "$2" 2>/dev/null || true
    }
    prov=33333333-3333-4333-8333-333333333333
    for _ in $(seq 1 360); do [ -n "$(jobframe "$prov" result)" ] && break; sleep 0.5; done
    eq "hello lists the 0.22 commands" "$(python3 -c 'import json, sys
print(json.loads(json.loads(open(sys.argv[1]).readline())["raw"]).get("commands"))' "$F/hostd-frames.jsonl")" \
        "['provision_agent', 'refresh_inventory', 'remove_agent', 'restart_agent']"
    eq "provision result" "$(jobframe "$prov" result | python3 -c 'import hashlib, json, sys
r = json.load(sys.stdin)
print(r["ok"], r["exitCode"], r.get("tokenSha256") == hashlib.sha256(("ec_" + "b" * 48).encode()).hexdigest())')" "True 0 True"
    scout=$HOME/.hermes/profiles/scout
    check "scout profile created" test -d "$scout"
    eq "scout .env is private" "$(stat -c %a "$scout/.env")" 600
    eq "scout .env: URL from hostd.env, token, identity" "$(python3 -c 'import sys
sys.path.insert(0, sys.argv[2])
from emperor_bridge.config import read_env_file
e = read_env_file(sys.argv[1])
print(e.get("EMPEROR_CLAW_API_URL"), e.get("EMPEROR_CLAW_API_TOKEN") == "ec_" + "b" * 48, e.get("EMPEROR_CLAW_AGENT_ID"), e.get("EMPEROR_CLAW_AGENT_NAME"))' \
        "$scout/.env" "$HOME/.hermes/emperor-bridge/current/bridge")" "http://127.0.0.1:18091 True 66666666-6666-4666-8666-666666666666 Scout"
    eq "only the deepseek key line was copied" "$(grep -c '_API_KEY=' "$scout/.env") $(grep -c '^DEEPSEEK_API_KEY="sk-fake-' "$scout/.env")" "1 1"
    check "model provider set via the pinned launcher" contains "$HOME/.hermes/fake-hermes.log" "scout config set model.provider=deepseek via 0.22.4"
    check "model set" contains "$HOME/.hermes/fake-hermes.log" "scout config set model.default=deepseek-chat via 0.22.4"
    check "scout installed standalone" bash -c "systemctl --user is-active --quiet emperor-hermes-gateway@scout && systemctl --user is-active --quiet emperor-hermes-bridge@scout"
    check "progress steps streamed" bash -c "grep -q 'Creating Hermes profile scout' '$F/hostd-frames.jsonl' && grep -q 'Waiting for Scout' '$F/hostd-frames.jsonl'"
    check "no bundle download for the new profile" grep -Eq 'bridge [0-9][0-9.]* already installed' "$HOME/.local/share/emperor-hermes/jobs/$prov.log"
    check "the reused release carries its unpack stamp" test -s "$HOME/.hermes/emperor-bridge/current/.unpacked"
    check_not "no ownership marker left without a reason" test -s "$HOME/.local/share/emperor-hermes/hostd-profiles/qa.json"
    check_not "the spec file is gone" bash -c "ls $HOME/.local/share/emperor-hermes/jobs/*.spec"
    check_not "no agent token in any frame" grep -q 'ec_bbbbbbbb' "$F/hostd-frames.jsonl"
    check_not "no agent token in the job files" grep -rq 'ec_bbbbbbbb' "$HOME/.local/share/emperor-hermes/jobs"
    check_not "no agent token in the daemon log" grep -q 'ec_bbbbbbbb' "$HOME/.local/share/emperor-hermes/hostd.log"
    : >"$F/do-remove"
    rm_job=55555555-5555-4555-8555-555555555555
    for _ in $(seq 1 120); do [ -n "$(jobframe "$rm_job" result)" ] && break; sleep 0.5; done
    eq "a removal for another agent's profile is refused" "$(jobframe 44444444-4444-4444-8444-444444444444 ack | python3 -c 'import json, sys
a = json.load(sys.stdin); print(a["accepted"], "agent_mismatch" in a.get("reason", ""))')" "False True"
    check "qa untouched by the refused removal" active emperor-hermes-bridge@qa
    eq "remove result" "$(jobframe "$rm_job" result | python3 -c 'import json, sys; r = json.load(sys.stdin); print(r["ok"], r["exitCode"])')" "True 0"
    check_not "scout profile purged" test -d "$scout"
    check_not "scout record purged" test -e "$HOME/.local/share/emperor-hermes/profiles/scout.env"
    check_not "scout ownership marker dropped after the removal" test -e "$HOME/.local/share/emperor-hermes/hostd-profiles/scout.json"
    check_not "scout units stopped" active emperor-hermes-bridge@scout
    check_not "no LLM key in any frame after provisioning" grep -q 'sk-fake-' "$F/hostd-frames.jsonl"

    # A rollback to a bridge without the daemon stops it; installing a bundle with it starts it again.
    rel="$HOME/.hermes/emperor-bridge/releases"
    rm -rf "$rel/0.8.0"
    cp -R "$(readlink -f "$HOME/.hermes/emperor-bridge/current")" "$rel/0.8.0"
    rm -rf "$rel/0.8.0/bridge/emperor_hostd"
    echo 0.8.0 >"$rel/0.8.0/VERSION"
    sed -i 's/^bridge_previous=.*//' "$HOME/.local/share/emperor-hermes/host.state"
    printf 'bridge_previous="0.8.0"\n' >>"$HOME/.local/share/emperor-hermes/host.state"
    check "rollback --bridge-only to a bundle without the daemon" eh rollback --bridge-only
    check_not "hostd stopped on the old bundle" active emperor-hermes-hostd.service
    check_not "hostd disabled on the old bundle" enabled emperor-hermes-hostd.service
    check "update back to a bundle with the daemon" eh update --bundle "$bundle"
    check "hostd enabled again" enabled emperor-hermes-hostd.service
    check "hostd running again" active emperor-hermes-hostd.service

    : >"$F/revoke"
    systemctl --user restart emperor-hermes-hostd.service
    for _ in $(seq 1 30); do active emperor-hermes-hostd.service || break; sleep 0.5; done
    check_not "a revoked host's daemon stops" active emperor-hermes-hostd.service
    eq "and exits 78 (no restart loop)" "$(systemctl --user show -p ExecMainStatus --value emperor-hermes-hostd.service)" 78
    rm -f "$F/revoke"

    # Back on the installer's own bundle (bridges and daemon then run from it, writing caches):
    # connecting again without --bundle reuses it instead of downloading; a changed file does not.
    check "update to the installer's own bundle" eh update --bundle "$bundle_cur"
    check "bridges run from it" active emperor-hermes-bridge@qa
    python3 -c 'import sys; sys.path.insert(0, sys.argv[1]); import emperor_bridge.config, emperor_hostd.provision'         "$HOME/.hermes/emperor-bridge/current/bridge"
    : >"$HOME/.local/share/emperor-hermes/emperor-hermes.log"
    check "host connect without --bundle reuses the unpacked bundle" eh host connect --url http://127.0.0.1:18080 ABCD-EFGH
    check "no download" grep -Eq 'bridge [0-9][0-9.]* already installed' "$HOME/.local/share/emperor-hermes/emperor-hermes.log"
    echo "# changed" >>"$HOME/.hermes/emperor-bridge/current/bridge/emperor_hostd/version.py"
    out_rc=0
    out=$(eh host connect --url http://127.0.0.1:18080 ABCD-EFGH 2>&1) || out_rc=$?
    check_not "a changed release is not reused" grep -Eq 'bridge [0-9][0-9.]* already installed' <<<"$out"
    check "host disconnect" eh host disconnect
    check_not "hostd disabled" enabled emperor-hermes-hostd.service
    check_not "host token deleted" test -e "$HOME/.config/emperor-hermes/hostd.env"
    check_not "host status reports not connected" eh host status

    out_rc=0
    eh remove --profile qa </dev/null >/dev/null 2>&1 || out_rc=$?
    check_not "remove asks first (refuses without a terminal or --yes)" test "$out_rc" = 0
    check "qa still runs after the refusal" active emperor-hermes-bridge@qa
    check "remove --yes" eh remove --profile qa --yes
    check_not "gateway@qa stopped" active emperor-hermes-gateway@qa
    check_not "bridge@qa disabled" enabled emperor-hermes-bridge@qa
    check "qa profile archived" bash -c "ls -d $HOME/.hermes/backups/emperor-hermes/removed/qa-*"
    check_not "qa profile dir gone" test -d "$HOME/.hermes/profiles/qa"
    eq "qa record says removed" "$(sed -n 's/^status="\(.*\)"/\1/p' "$HOME/.local/share/emperor-hermes/profiles/qa.env")" removed

    section "/proc scan noise"
    out=$( { tr '\0' ' ' 2>/dev/null <"/proc/99999999/cmdline"; tr '\0' '\n' 2>/dev/null <"/proc/99999999/environ"; } 2>&1 || true)
    check_not "a vanished process is skipped silently (no 'No such file or directory')" grep -q 'No such file or directory' <<<"$out"

    printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
    [ "$FAIL" = 0 ]
}

if [ "${1:-}" = --inside ]; then inside_main; else host_main; fi
