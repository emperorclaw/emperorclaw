"""Agent secrets -> profile .env sync (bridge 0.36): block rendering, atomic apply and the loop.

Stdlib only: the dotenv round trip is checked with the bridge's own parser, and with python-dotenv
when the interpreter running the suite happens to have it.
"""
from __future__ import annotations

import io
import json
import os
import stat
import sys
import tempfile
import unittest
import urllib.error
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
BRIDGE_DIR = REPO / "integrations" / "hermes" / "emperor-claw" / "bridge"
if str(BRIDGE_DIR) not in sys.path:
    sys.path.insert(0, str(BRIDGE_DIR))

from emperor_bridge import events, secrets_sync  # noqa: E402
from emperor_bridge.config import read_env_file  # noqa: E402
from emperor_hostd import provision  # noqa: E402

try:
    from dotenv import dotenv_values  # noqa: F401
    HAS_DOTENV = True
except ImportError:
    HAS_DOTENV = False

POSIX = os.name == "posix"
URL = "https://emperor.example.com"


class FakeHeaders:
    def __init__(self, values: dict[str, str]) -> None:
        self._values = values

    def items(self):
        return self._values.items()


class FakeResponse:
    def __init__(self, status: int, body: str = "", headers: dict[str, str] | None = None) -> None:
        self.status = status
        self._body = body.encode("utf-8")
        self.headers = FakeHeaders(headers or {})

    def read(self) -> bytes:
        return self._body

    def __enter__(self) -> "FakeResponse":
        return self

    def __exit__(self, *_exc) -> bool:
        return False


def http_error(code: int, body: str = "") -> urllib.error.HTTPError:
    return urllib.error.HTTPError(URL, code, "error", {}, io.BytesIO(body.encode("utf-8")))


def write_env(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


class RenderBlockTests(unittest.TestCase):
    VALUES = {
        "SPACES": "two words and more",
        "HASH": "a#b # still a value",
        "DOLLAR": "$HOME and $PLAIN",
        "EQUAL": "x=y=z",
        "SINGLE": "it's fine",
        "DOUBLE": 'say "hi"',
        "BACKSLASH": r"C:\path\to\thing",
        "BOTH": "a'b\"c\\d",
        "COMBINED": "p@ss w#rd $x = it's \"q\" \\ z",
    }

    def test_render_round_trips_through_the_bridge_parser(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / ".env"
            block = secrets_sync.render_block([{"name": name, "value": value} for name, value in self.VALUES.items()])
            self.assertIn(secrets_sync.MANAGED_START, block)
            self.assertIn(secrets_sync.MANAGED_END, block)
            write_env(path, "KEEP=1\n" + block)
            self.assertEqual(read_env_file(path), {"KEEP": "1", **self.VALUES})

    def test_render_round_trips_through_python_dotenv_when_available(self) -> None:
        try:
            from dotenv import dotenv_values
        except ImportError:
            self.skipTest("python-dotenv is not installed in this interpreter")
        block = secrets_sync.render_block([{"name": name, "value": value} for name, value in self.VALUES.items()])
        parsed = dotenv_values(stream=io.StringIO(block))
        for name, value in self.VALUES.items():
            self.assertEqual(parsed.get(name), value, name)

    def test_names_are_sorted_and_empty_renders_nothing(self) -> None:
        block = secrets_sync.render_block([{"name": "BB", "value": "2"}, {"name": "AA", "value": "1"}])
        self.assertLess(block.index("AA="), block.index("BB="))
        self.assertEqual(secrets_sync.render_block([]), "")

    def test_a_newline_value_is_skipped(self) -> None:
        block = secrets_sync.render_block([{"name": "GOOD", "value": "ok"}, {"name": "BAD", "value": "a\nb"}])
        self.assertIn("GOOD='ok'", block)
        self.assertNotIn("BAD=", block)

    def test_a_line_separator_value_is_skipped_and_cannot_forge_the_end_marker(self) -> None:
        for separator in ("\r", "\x0b", "\x0c", "\x1c", "\x1d", "\x1e", "\x85", "\u2028", "\u2029"):
            with self.subTest(separator=repr(separator)):
                forged = "x" + separator + secrets_sync.MANAGED_END
                block = secrets_sync.render_block([{"name": "GOOD", "value": "ok"},
                                                   {"name": "BAD", "value": forged}])
                self.assertIn("GOOD='ok'", block)
                self.assertNotIn("BAD=", block)
                self.assertEqual(block.count(secrets_sync.MANAGED_END), 1)

    def test_a_name_outside_the_secret_pattern_is_skipped(self) -> None:
        block = secrets_sync.render_block([{"name": "lower_case", "value": "x"},
                                           {"name": "GOOD", "value": "y"}])
        self.assertNotIn("lower_case", block)
        self.assertIn("GOOD='y'", block)

    DOTENV_VALUES = {
        "V_BACK": r"back\slash",
        "V_BOTH": r"""q'\n"x""",
        "V_DOLLAR": "p$ss=w",
        "V_DOUBLE": 'say "hi"',
        "V_HASH": "a b#c",
        "V_SINGLE": "it's",
        "V_TWO": r"two\\slashes",
        "V_ZZ_QUOTE_AFTER_SLASH": 'a\\"',
    }

    def test_a_value_ending_in_a_backslash_is_skipped(self) -> None:
        # In python-dotenv a trailing backslash escapes the closing quote, so the parser reads on
        # into the next quoted line; such a value must never reach the file.
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / ".env"
            write_env(path, "KEEP=1\n")
            result = secrets_sync.apply_block(path, [{"name": "A_END", "value": "ends\\"},
                                                     {"name": "B_NEXT", "value": 'say "hi"'}])
            self.assertEqual(result.skipped, ("A_END",))
            self.assertEqual(result.names, ("B_NEXT",))
            self.assertNotIn("A_END", path.read_text(encoding="utf-8"))

    @unittest.skipUnless(HAS_DOTENV, "python-dotenv is not installed")
    def test_dotenv_reads_the_quoting_back_through_apply_block(self) -> None:
        from dotenv import dotenv_values
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / ".env"
            write_env(path, "KEEP=1\n")
            rows = [{"name": name, "value": value} for name, value in self.DOTENV_VALUES.items()]
            rows.append({"name": "Z_AFTER", "value": "after"})
            result = secrets_sync.apply_block(path, rows)
            self.assertTrue(result.written)
            parsed = dotenv_values(path)
            for name, value in self.DOTENV_VALUES.items():
                self.assertEqual(parsed.get(name), value, name)
            self.assertEqual(parsed.get("Z_AFTER"), "after", "keys after the tricky values survive")
            self.assertEqual(parsed.get("KEEP"), "1")


class ApplyBlockTests(unittest.TestCase):
    def test_lines_outside_the_block_are_preserved(self) -> None:
        original = "# top\nFOO=bar\n\nBAZ='qux'\n"
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / ".env"
            write_env(path, original)
            result = secrets_sync.apply_block(path, [{"name": "TOKEN", "value": "abc"}])
            self.assertTrue(result.written)
            text = path.read_text(encoding="utf-8")
            self.assertTrue(text.startswith(original))
            self.assertIn("TOKEN='abc'", text)
            self.assertEqual(text.splitlines()[: original.count("\n")], original.splitlines())

    def test_a_name_defined_outside_is_skipped(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / ".env"
            write_env(path, "API_KEY='outside'\n# tail\n")
            result = secrets_sync.apply_block(path, [{"name": "API_KEY", "value": "server"},
                                                     {"name": "OTHER", "value": "x"}])
            self.assertIn("API_KEY", result.skipped)
            text = path.read_text(encoding="utf-8")
            self.assertIn("API_KEY='outside'", text)
            self.assertNotIn("API_KEY='server'", text)
            self.assertIn("OTHER='x'", text)

    def test_an_empty_list_removes_the_block(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / ".env"
            write_env(path, "KEEP=1\n")
            secrets_sync.apply_block(path, [{"name": "TOKEN", "value": "abc"}])
            self.assertIn(secrets_sync.MANAGED_START, path.read_text(encoding="utf-8"))
            secrets_sync.apply_block(path, [])
            text = path.read_text(encoding="utf-8")
            self.assertNotIn(secrets_sync.MANAGED_START, text)
            self.assertNotIn(secrets_sync.MANAGED_END, text)
            self.assertIn("KEEP=1", text)

    @unittest.skipUnless(POSIX, "POSIX file modes")
    def test_the_written_file_is_0600(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / ".env"
            write_env(path, "KEEP=1\n")
            os.chmod(path, 0o644)
            secrets_sync.apply_block(path, [{"name": "TOKEN", "value": "abc"}])
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)

    def test_a_missing_env_is_not_created(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / ".env"
            result = secrets_sync.apply_block(path, [{"name": "TOKEN", "value": "abc"}])
            self.assertFalse(result.written)
            self.assertFalse(path.exists())


class FetchSecretsTests(unittest.TestCase):
    def fetch_with(self, response=None, error=None):
        def opener(_request, timeout=0):
            self.assertGreater(timeout, 0)
            if error is not None:
                raise error
            return response
        return secrets_sync.fetch_secrets(URL, "token", "", opener=opener)

    def test_200_returns_the_payload_and_etag(self) -> None:
        payload = {"etag": "e1", "secrets": [{"name": "A", "value": "v", "exposeToTools": False}], "failed": ["B"]}
        result = self.fetch_with(FakeResponse(200, json.dumps(payload), {"ETag": '"e1"'}))
        self.assertEqual(result.kind, "ok")
        self.assertEqual(result.etag, '"e1"')
        self.assertEqual(result.secrets, ({"name": "A", "value": "v", "exposeToTools": False},))
        self.assertEqual(result.failed, ("B",))

    def test_304_is_unchanged(self) -> None:
        self.assertEqual(self.fetch_with(error=http_error(304)).kind, "unchanged")

    def test_403_agent_bound_and_404_disable(self) -> None:
        bound = http_error(403, '{"error":"agent_bound_token_required"}')
        self.assertEqual(self.fetch_with(error=bound).kind, "disabled")
        self.assertEqual(self.fetch_with(error=http_error(404)).kind, "disabled")

    def test_other_errors_retry_later(self) -> None:
        for error in (http_error(401), http_error(403, "forbidden"), http_error(500), urllib.error.URLError("down")):
            with self.subTest(error=error):
                self.assertEqual(self.fetch_with(error=error).kind, "retry")

    def test_redirects_are_not_followed(self) -> None:
        self.assertIsNone(secrets_sync._NoRedirectHandler().redirect_request(
            None, None, 302, "Found", {}, "https://evil.example.com"))
        for code in (301, 302, 303, 307, 308):
            with self.subTest(code=code):
                self.assertEqual(self.fetch_with(error=http_error(code)).kind, "retry")

    def test_a_payload_without_a_secret_list_retries(self) -> None:
        for body in ("{}", '{"secrets": null}', '{"secrets": "nope"}', '{"secrets": {"A": "v"}}'):
            with self.subTest(body=body):
                result = self.fetch_with(FakeResponse(200, body, {"ETag": '"e1"'}))
                self.assertEqual(result.kind, "retry")
                self.assertEqual(result.reason, "unexpected payload")

    def test_an_empty_secret_list_is_still_a_valid_no_secrets(self) -> None:
        result = self.fetch_with(FakeResponse(200, '{"secrets": []}', {"ETag": '"e1"'}))
        self.assertEqual(result.kind, "ok")
        self.assertEqual(result.secrets, ())
        self.assertEqual(result.failed, ())


class SyncOnceTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.path = Path(self.tmp.name) / "profile" / ".env"
        write_env(self.path, "OUTSIDE=1\n" + secrets_sync.render_block([{"name": "SECRET", "value": "old"}]))

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def state(self) -> secrets_sync.SyncState:
        text = self.path.read_text(encoding="utf-8")
        return secrets_sync.SyncState(etag='"e1"', block_hash=secrets_sync.block_hash(text))

    def run_sync(self, state, fetch):
        return secrets_sync.sync_once(state, base_url=URL, agent_token="token", env_path=self.path, fetch=fetch)

    def test_304_leaves_the_file_alone(self) -> None:
        before = self.path.read_text(encoding="utf-8")
        calls: list[str] = []

        def fetch(_base, _token, etag):
            calls.append(etag)
            return secrets_sync.FetchResult("unchanged")

        self.assertEqual(self.run_sync(self.state(), fetch), "unchanged")
        self.assertEqual(calls, ['"e1"'])
        self.assertEqual(self.path.read_text(encoding="utf-8"), before)

    def test_403_or_404_disables_until_restart(self) -> None:
        for reason in ("agent_bound_token_required", "runtime secrets endpoint not available"):
            state = self.state()

            def disabled(_base, _token, _etag, reason=reason):
                return secrets_sync.FetchResult("disabled", reason=reason)

            self.assertEqual(self.run_sync(state, disabled), "disabled")
            self.assertTrue(state.disabled)
            self.assertEqual(self.run_sync(state, lambda *_args: self.fail("disabled profiles are not retried")), "disabled")

    def test_a_network_error_keeps_the_block(self) -> None:
        before = self.path.read_text(encoding="utf-8")
        state = self.state()
        self.assertEqual(self.run_sync(state, lambda *_args: secrets_sync.FetchResult("retry", reason="down")), "retry")
        self.assertEqual(self.path.read_text(encoding="utf-8"), before)
        self.assertEqual(state.etag, '"e1"')

    def test_an_unexpected_payload_keeps_the_block(self) -> None:
        before = self.path.read_text(encoding="utf-8")
        state = self.state()

        def opener(_request, timeout=0):
            return FakeResponse(200, "{}", {"ETag": '"e2"'})

        def fetch(base, token, etag):
            return secrets_sync.fetch_secrets(base, token, etag, opener=opener)

        self.assertEqual(self.run_sync(state, fetch), "retry")
        self.assertEqual(self.path.read_text(encoding="utf-8"), before)

    def test_a_failed_name_keeps_its_line_while_another_secret_rotates(self) -> None:
        write_env(self.path, "OUTSIDE=1\n" + secrets_sync.render_block([
            {"name": "SECRET", "value": "old"},
            {"name": "GOOD", "value": "old-good"},
        ]))
        state = self.state()
        result = secrets_sync.FetchResult(
            "ok", etag='"e2"',
            secrets=({"name": "GOOD", "value": "new-good"},),
            failed=("SECRET",),
        )
        self.assertEqual(self.run_sync(state, lambda *_args: result), "ok")
        text = self.path.read_text(encoding="utf-8")
        self.assertIn("SECRET='old'", text, "the unreadable secret's line survives")
        self.assertIn("GOOD='new-good'", text)
        self.assertNotIn("GOOD='old-good'", text)

    def test_a_tampered_block_forces_a_full_refetch(self) -> None:
        state = self.state()
        self.path.write_text(self.path.read_text(encoding="utf-8").replace("'old'", "'tampered'"), encoding="utf-8")
        calls: list[str] = []

        def fetch(_base, _token, etag):
            calls.append(etag)
            return secrets_sync.FetchResult(
                "ok", etag='"e2"', secrets=({"name": "SECRET", "value": "new-value-for-tamper"},))

        self.assertEqual(self.run_sync(state, fetch), "ok")
        self.assertEqual(calls, [""])
        self.assertIn("SECRET='new-value-for-tamper'", self.path.read_text(encoding="utf-8"))
        self.assertEqual(state.etag, '"e2"')

    def test_fetched_values_are_registered_with_the_event_redactor(self) -> None:
        value = "value with spaces and 1234567890"
        state = self.state()
        self.run_sync(state, lambda *_args: secrets_sync.FetchResult(
            "ok", etag='"e2"', secrets=({"name": "SECRET", "value": value},)))
        self.assertNotIn(value, events.redact(f"leaked: {value}", 300))

    def test_no_token_and_missing_env_are_skipped(self) -> None:
        state = self.state()
        self.assertEqual(secrets_sync.sync_once(state, base_url=URL, agent_token="", env_path=self.path,
                                                fetch=lambda *_args: self.fail("no token, no request")), "skipped")
        missing = Path(self.tmp.name) / "missing" / ".env"
        outcome = secrets_sync.sync_once(state, base_url=URL, agent_token="token", env_path=missing,
                                         fetch=lambda *_args: secrets_sync.FetchResult(
                                             "ok", etag='"e2"', secrets=({"name": "X", "value": "y"},)))
        self.assertEqual(outcome, "missing")
        self.assertFalse(missing.exists())


class BoundedDataTests(unittest.TestCase):
    def test_bounded_data_scrubs_strings_at_any_depth(self) -> None:
        secret = "nested-secret-value-123456"
        events.register_secrets([secret])
        data = {
            "top": f"has {secret}",
            "nested": {"deep": [f"x {secret}", {"deeper": secret}], "untouched": 7},
            "n": 1,
        }
        clean = events.bounded_data(data)
        encoded = json.dumps(clean)
        self.assertNotIn(secret, encoded)
        self.assertIn("[redacted]", encoded)
        self.assertEqual(clean["n"], 1)
        self.assertEqual(clean["nested"]["untouched"], 7)


class ProvisionRerunTests(unittest.TestCase):
    def test_scrub_env_keeps_the_managed_block(self) -> None:
        block = secrets_sync.render_block([{"name": "OPENAI_API_KEY", "value": "sk-abc"},
                                           {"name": "PLAIN", "value": "x"}])
        text = 'KEEP=1\nEMPEROR_CLAW_API_TOKEN="old"\n' + block + "TAIL=2\n"
        kept = provision.scrub_env(text)
        for line in block.splitlines():
            self.assertIn(line, kept)
        self.assertIn("KEEP=1", kept)
        self.assertIn("TAIL=2", kept)
        self.assertNotIn('EMPEROR_CLAW_API_TOKEN="old"', kept)

    def test_scrub_env_stops_a_marker_without_an_end(self) -> None:
        cases = {
            "blank line": (
                "KEEP=1\n"
                f"{secrets_sync.MANAGED_START}\n"
                "MANAGED_KEY='x'\n"
                "\n"
                "TAIL=2\n"
                'EMPEROR_CLAW_API_TOKEN="old"\n'
            ),
            "comment line": (
                "KEEP=1\n"
                f"{secrets_sync.MANAGED_START}\n"
                "MANAGED_KEY='x'\n"
                "# tail comment\n"
                'EMPEROR_CLAW_API_TOKEN="old"\n'
            ),
        }
        for label, text in cases.items():
            with self.subTest(label=label):
                kept = provision.scrub_env(text)
                self.assertIn("MANAGED_KEY='x'", kept)
                self.assertIn("KEEP=1", kept)
                self.assertNotIn('EMPEROR_CLAW_API_TOKEN="old"', kept)
        blank_line_kept = provision.scrub_env(cases["blank line"])
        self.assertIn("TAIL=2", blank_line_kept)
        comment_kept = provision.scrub_env(cases["comment line"])
        self.assertIn("# tail comment", comment_kept)

    def test_compose_env_keeps_the_block_while_rewriting_identity(self) -> None:
        block = secrets_sync.render_block([{"name": "PLAIN", "value": "x"}])
        composed = provision.compose_env("KEEP=1\n" + block, "https://emperor.example.com", "tok", "id", "name",
                                         "DEEPSEEK_API_KEY", "key")
        self.assertIn("KEEP=1", composed)
        self.assertIn(secrets_sync.MANAGED_START, composed)
        self.assertIn("PLAIN='x'", composed)
        self.assertIn('EMPEROR_CLAW_API_TOKEN="tok"', composed)

    def test_managed_values_include_every_name(self) -> None:
        block = secrets_sync.render_block([{"name": "NOT_A_SECRET_NAME", "value": "hello"}])
        self.assertEqual(secrets_sync.managed_values("KEEP=1\n" + block), {"NOT_A_SECRET_NAME": "hello"})


if __name__ == "__main__":
    unittest.main()
