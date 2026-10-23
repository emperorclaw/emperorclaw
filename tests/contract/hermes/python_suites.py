"""Run every Python test suite of the repo: the runner behind ``npm run test:bridge``.

Discovers instead of listing, so a new ``tests/*.test.py`` can never be silently left out of CI
again (hermes-latency, hermes-plugin-results and agent-chat were not run before 0.9):

* every ``tests/*.test.py`` file, each in its own interpreter (they are unittest scripts);
* ``tests/bridge/`` (bridge 0.9 unit tests, W3/W4/W6) via ``unittest discover``; at least one test
  must run, so pytest-only test functions (which unittest would skip) fail loudly.

``--plugin-only`` runs just ``tests/hermes-plugin-*.test.py``: the plugin is the only Python that
also runs outside a Hermes venv, so CI runs it on Python 3.11 too (design 0.9 §9.3).

Live suites need a running Emperor and are skipped (with the reason) unless their env is set:
``agent-chat.test.py`` needs ``EMPEROR_CLAW_API_TOKEN``.

``PYTHON_SUITES_STRICT=1`` (CI) fails when an expected suite is missing: the plugin-context test
(W5) and ``tests/bridge/`` (W3). Stdlib only. Usage: ``python3 tests/contract/hermes/python_suites.py``.
"""
from __future__ import annotations

import os
import re
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
TESTS = ROOT / "tests"
LIVE = {"agent-chat.test.py": "EMPEROR_CLAW_API_TOKEN"}
EXPECTED = [TESTS / "hermes-plugin-context.test.py", TESTS / "bridge"]


def run(cmd: list[str], label: str) -> tuple[int, str]:
    t0 = time.monotonic()
    proc = subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True)
    out = proc.stdout + proc.stderr
    print(f"{'PASS' if proc.returncode == 0 else 'FAIL'}  {label}  ({time.monotonic() - t0:.1f} s)", flush=True)
    if proc.returncode != 0:
        print("\n".join("    " + line for line in out.rstrip().splitlines()[-60:]), flush=True)
    return proc.returncode, out


def main(argv: list[str]) -> int:
    plugin_only = "--plugin-only" in argv
    strict = os.environ.get("PYTHON_SUITES_STRICT") == "1"
    print(f"python {sys.version.split()[0]}  ({sys.executable})  plugin_only={plugin_only} strict={strict}")
    failures: list[str] = []
    pattern = "hermes-plugin-*.test.py" if plugin_only else "*.test.py"
    files = sorted(TESTS.glob(pattern))
    if not files:
        failures.append(f"no tests/{pattern} found")
    for f in files:
        env_needed = LIVE.get(f.name)
        if env_needed and not os.environ.get(env_needed):
            print(f"SKIP  {f.name}  (live suite: set {env_needed} to run it against a real instance)")
            continue
        rc, _ = run([sys.executable, str(f)], f.name)
        if rc != 0:
            failures.append(f.name)
    if not plugin_only:
        bridge = TESTS / "bridge"
        if bridge.is_dir() and any(bridge.glob("test_*.py")):
            rc, out = run([sys.executable, "-m", "unittest", "discover", "-s", str(bridge), "-t", str(bridge),
                           "-p", "test_*.py"], "tests/bridge (unittest discover)")
            ran = re.search(r"Ran (\d+) tests?", out)
            if rc != 0:
                failures.append("tests/bridge")
            elif not ran or int(ran.group(1)) == 0:
                print("FAIL  tests/bridge  (0 tests collected: write unittest.TestCase classes, not bare functions)")
                failures.append("tests/bridge (0 tests)")
    missing = [p for p in EXPECTED if not p.exists() and (not plugin_only or p.name.startswith("hermes-plugin-"))]
    for p in missing:
        print(f"{'FAIL' if strict else 'WARN'}  missing expected suite {p.relative_to(ROOT)}")
    if strict:
        failures += [str(p.relative_to(ROOT)) for p in missing]
    print(f"\n{len(failures)} failing: {', '.join(failures)}" if failures else "\nall Python suites passed")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
