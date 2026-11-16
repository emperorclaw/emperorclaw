"""Chat attachments reach a Hermes agent: thread reads list them and
emperor_download_attachment saves the bytes to a per-agent folder, binary safe,
with a sanitized file name and a size cap.
"""
import importlib.util
import io
import json
import os
import tempfile
import unittest
import urllib.error
from email.message import Message
from pathlib import Path
from unittest.mock import patch

path = Path(__file__).resolve().parent.parent / "integrations/hermes/emperor-claw/__init__.py"
spec = importlib.util.spec_from_file_location("hermes_plugin_attachments", path)
plugin = importlib.util.module_from_spec(spec)
spec.loader.exec_module(plugin)

ARTIFACT = "0f8fad5b-d9cb-469f-a165-70867728950e"
XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
# Not valid UTF-8: proves the bytes are never decoded.
BINARY = b"PK\x03\x04\xff\xfe\x00\x80binary\x00" * 64


class FakeResponse:
    def __init__(self, body: bytes, headers: dict, status: int = 200):
        self._body = io.BytesIO(body)
        self.headers = Message()
        for key, value in headers.items():
            self.headers[key] = value
        self.status = status
        self.reads = 0

    def read(self, size: int = -1) -> bytes:
        self.reads += 1
        return self._body.read(size)

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


def response(body: bytes = BINARY, name: str = "report.xlsx", content_type: str = XLSX, length: bool = True):
    headers = {"Content-Type": content_type, "Content-Disposition": f'attachment; filename="{name}"'}
    if length:
        headers["Content-Length"] = str(len(body))
    return FakeResponse(body, headers)


class MessageSummaryTests(unittest.TestCase):
    def test_summary_lists_attachments(self):
        row = plugin._message_summary({
            "id": "m1", "senderType": "human", "text": "", "createdAt": "2026-11-16T10:00:00Z",
            "metadataJson": {"senderName": "Jose", "attachments": [
                {"id": ARTIFACT, "name": "report.xlsx", "contentType": XLSX, "sizeBytes": 43622},
            ]},
        })
        self.assertEqual(row["attachments"], [
            {"id": ARTIFACT, "name": "report.xlsx", "contentType": XLSX, "sizeBytes": 43622}])
        self.assertEqual(row["sender"]["name"], "Jose")

    def test_summary_skips_malformed_attachments_and_omits_an_empty_list(self):
        for raw in (None, "x", {"id": "a"}, [None, 3, {"name": "no id"}]):
            row = plugin._message_summary({"id": "m", "text": "hi", "metadataJson": {"attachments": raw}})
            self.assertNotIn("attachments", row)
        row = plugin._message_summary({"id": "m", "text": "hi", "metadataJson": {"attachments": [
            {"id": "a1", "sizeBytes": "big"}, {"id": "a2", "name": "b.csv", "sizeBytes": True}]}})
        self.assertEqual(row["attachments"], [{"id": "a1", "name": "file"}, {"id": "a2", "name": "b.csv"}])

    def test_summary_caps_the_list(self):
        files = [{"id": f"a{i}", "name": f"{i}.txt"} for i in range(plugin.MESSAGE_ATTACHMENTS_MAX + 5)]
        row = plugin._message_summary({"id": "m", "metadataJson": {"attachments": files}})
        self.assertEqual(len(row["attachments"]), plugin.MESSAGE_ATTACHMENTS_MAX)

    def test_thread_read_carries_attachments(self):
        data = {"thread": {"id": "t1"}, "messages": [
            {"id": "m1", "text": "", "metadataJson": {"attachments": [{"id": ARTIFACT, "name": "r.xlsx"}]}}]}
        with patch.object(plugin, "_request", return_value={"ok": True, "data": data}):
            out = json.loads(plugin.emperor_get_thread_messages({"threadId": "t1"}))
        self.assertEqual(out["data"]["messages"][0]["attachments"], [{"id": ARTIFACT, "name": "r.xlsx"}])


class SafeFilenameTests(unittest.TestCase):
    def test_traversal_and_directories_are_stripped(self):
        self.assertEqual(plugin._safe_filename("../../etc/passwd"), "passwd")
        self.assertEqual(plugin._safe_filename("..\\..\\Windows\\win.ini"), "win.ini")
        self.assertEqual(plugin._safe_filename("/abs/path/report.xlsx"), "report.xlsx")

    def test_dot_names_and_empty_names_fall_back(self):
        for bad in ("", "..", ".", "...", "../", None, "\x00\x01"):
            self.assertEqual(plugin._safe_filename(bad, fallback="artifact-x"), "artifact-x")

    def test_hostile_characters_are_replaced(self):
        name = plugin._safe_filename('a<b>c:"d|e?*\x00\n.xlsx')
        self.assertTrue(name.endswith(".xlsx"))
        for ch in '<>:"|?*\x00\n/\\':
            self.assertNotIn(ch, name)
        self.assertEqual(plugin._safe_filename(".hidden"), "hidden")

    def test_windows_reserved_names_and_length(self):
        self.assertEqual(plugin._safe_filename("CON.txt"), "_CON.txt")
        long = plugin._safe_filename("x" * 300 + ".xlsx")
        self.assertLessEqual(len(long), 120)
        self.assertTrue(long.endswith(".xlsx"))

    def test_unicode_names_from_content_disposition(self):
        self.assertEqual(plugin._disposition_filename('attachment; filename="Q3%20report.xlsx"'), "Q3 report.xlsx")
        self.assertEqual(plugin._disposition_filename("attachment; filename*=UTF-8''r%C3%A9sum%C3%A9.pdf"), "résumé.pdf")
        self.assertEqual(plugin._disposition_filename(""), "")


class DownloadTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.home = Path(self.tmp.name) / "profiles" / "viktor"
        self.home.mkdir(parents=True)
        (self.home / ".env").write_text(
            "EMPEROR_CLAW_API_URL=https://emperor.test\nEMPEROR_CLAW_API_TOKEN=tok\nEMPEROR_CLAW_AGENT_ID=agent-1\n",
            encoding="utf-8")
        bound = patch.object(plugin, "_bound_env", return_value={"EMPEROR_PROFILE_HOME": str(self.home)})
        bound.start()
        self.addCleanup(bound.stop)
        self.addCleanup(self.tmp.cleanup)

    def download(self, fake, **args):
        with patch.object(plugin.urllib.request, "urlopen", return_value=fake) as urlopen:
            out = json.loads(plugin.emperor_download_attachment({"artifactId": ARTIFACT, **args}))
        return out, urlopen

    def test_saves_binary_bytes_in_the_agent_folder(self):
        out, urlopen = self.download(response())
        self.assertTrue(out["ok"], out)
        saved = Path(out["path"])
        self.assertEqual(saved.read_bytes(), BINARY)
        self.assertEqual(saved.parent, self.home / "emperor" / "attachments" / ARTIFACT)
        self.assertEqual((out["name"], out["contentType"], out["sizeBytes"]), ("report.xlsx", XLSX, len(BINARY)))
        req = urlopen.call_args.args[0]
        self.assertEqual(req.full_url, f"https://emperor.test/api/mcp/artifacts/{ARTIFACT}/download?agentId=agent-1")
        self.assertEqual(req.get_header("Authorization"), "Bearer tok")
        self.assertEqual([p.name for p in saved.parent.iterdir()], ["report.xlsx"], "no .part file left behind")

    def test_server_filename_cannot_escape_the_folder(self):
        out, _ = self.download(response(name="../../../.bashrc"))
        self.assertTrue(out["ok"], out)
        self.assertEqual(out["name"], "bashrc")
        self.assertEqual(Path(out["path"]).parent, self.home / "emperor" / "attachments" / ARTIFACT)
        self.assertFalse((self.home / ".bashrc").exists())

    def test_artifact_id_is_validated(self):
        for bad in ("", "../x", "a/b", "x" * 200):
            with patch.object(plugin.urllib.request, "urlopen") as urlopen:
                out = json.loads(plugin.emperor_download_attachment({"artifactId": bad}))
            self.assertFalse(out["ok"])
            urlopen.assert_not_called()

    def test_declared_size_over_the_cap_is_refused_without_reading(self):
        fake = response(body=b"x" * 10)
        fake.headers.replace_header("Content-Length", str(plugin.DEFAULT_ATTACHMENT_MAX_BYTES + 1))
        out, _ = self.download(fake)
        self.assertFalse(out["ok"])
        self.assertIn("limit", out["error"])
        self.assertEqual(fake.reads, 0)
        self.assertFalse((self.home / "emperor" / "attachments" / ARTIFACT).exists())

    def test_streamed_size_over_the_cap_is_refused(self):
        with patch.dict(os.environ, {"EMPEROR_ATTACHMENT_MAX_BYTES": "100"}):
            out, _ = self.download(response(body=b"y" * 101, length=False))
        self.assertFalse(out["ok"])
        self.assertIn("100 byte", out["error"])
        with patch.dict(os.environ, {"EMPEROR_ATTACHMENT_MAX_BYTES": "100"}):
            out, _ = self.download(response(body=b"y" * 100, length=False))
        self.assertTrue(out["ok"], out)

    def test_http_errors_are_reported(self):
        error = urllib.error.HTTPError("u", 404, "Not Found", Message(), io.BytesIO(b'{"error":"Artifact not found"}'))
        with patch.object(plugin.urllib.request, "urlopen", side_effect=error):
            out = json.loads(plugin.emperor_download_attachment({"artifactId": ARTIFACT}))
        self.assertEqual((out["ok"], out["status"], out["error"]), (False, 404, {"error": "Artifact not found"}))

    def test_name_argument_is_used_when_the_server_sends_none(self):
        fake = FakeResponse(BINARY, {"Content-Type": "application/pdf"})
        out, _ = self.download(fake, name="../invoice.pdf")
        self.assertEqual(out["name"], "invoice.pdf")
        self.assertEqual(out["contentType"], "application/pdf")

    def test_missing_token_is_a_clear_error(self):
        (self.home / ".env").write_text("EMPEROR_CLAW_API_URL=https://emperor.test\n", encoding="utf-8")
        with patch.object(plugin.urllib.request, "urlopen") as urlopen:
            out = json.loads(plugin.emperor_download_attachment({"artifactId": ARTIFACT}))
        self.assertFalse(out["ok"])
        self.assertIn("EMPEROR_CLAW_API_TOKEN", out["error"])
        urlopen.assert_not_called()


class RegistrationTests(unittest.TestCase):
    def test_tool_is_registered_with_a_required_artifact_id(self):
        class Context:
            def __init__(self):
                self.tools = {}

            def register_tool(self, name, toolset, schema, fn, **kwargs):
                self.tools[name] = (schema, fn)

            def register_skill(self, *args):
                pass

            def register_hook(self, *args):
                pass

        ctx = Context()
        plugin.register(ctx)
        schema, fn = ctx.tools["emperor_download_attachment"]
        self.assertIs(fn, plugin.emperor_download_attachment)
        self.assertEqual(schema["parameters"]["required"], ["artifactId"])


if __name__ == "__main__":
    unittest.main()
