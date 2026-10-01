from contextlib import redirect_stdout
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import sys
import unittest
from unittest.mock import patch

SCRIPTS = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SCRIPTS))

from shared import ado
from shared.transport import AdoError, authorization, azure_cli_invocation


class WindowsInvocationTests(unittest.TestCase):
    def test_native_executable_preserves_argument_boundaries(self):
        native = r"C:\Program Files\Azure CLI\az.exe"
        args = ["az", "repos", "pr", "show", "--id", "42"]
        actual = azure_cli_invocation(
            args, platform="win32", find=lambda name: native if name == "az.exe" else None,
        )
        self.assertEqual(actual, [native, "repos", "pr", "show", "--id", "42"])

    def test_windows_command_shim_uses_its_bundled_python_without_a_shell(self):
        shim = r"C:\Program Files\Azure CLI\wbin\az.cmd"
        python = r"C:\Program Files\Azure CLI\python.exe"
        actual = azure_cli_invocation(
            ["az", "account", "get-access-token"], platform="win32",
            find=lambda name: shim if name == "az" else None, exists=lambda file: file == python,
        )
        self.assertEqual(actual, [python, "-X", "utf8", "-IBm", "azure.cli", "account", "get-access-token"])

    def test_missing_native_windows_installation_is_an_explicit_error(self):
        with self.assertRaisesRegex(AdoError, "native executable"):
            azure_cli_invocation(
                ["az", "account"], platform="win32",
                find=lambda _: r"C:\shims\az.cmd", exists=lambda _: False,
            )

    def test_unix_executable_uses_the_same_argument_contract(self):
        self.assertEqual(
            azure_cli_invocation(["az", "account"], platform="linux", find=lambda _: "/usr/bin/az"),
            ["/usr/bin/az", "account"],
        )

    def test_shared_cli_helpers_use_the_native_windows_invocation(self):
        native_args = [r"C:\Azure CLI\python.exe", "-IBm", "azure.cli", "devops", "configure"]
        with patch("shared.ado.azure_cli_invocation", return_value=native_args), \
             patch("shared.ado.subprocess.run", return_value=subprocess.CompletedProcess(native_args, 0, stdout="{}")) as run:
            self.assertEqual(ado.run(["az", "devops", "configure"]), "{}")
        self.assertEqual(run.call_args.args[0], native_args)
        self.assertNotIn("shell", run.call_args.kwargs)

    def test_failed_native_launch_can_use_configured_pat(self):
        with patch.dict(os.environ, {}, clear=True), \
             patch("shared.transport.azure_cli_invocation", return_value=["az"]), \
             patch("shared.transport.subprocess.run", side_effect=OSError(193, "invalid executable")), \
             patch("shared.transport.stored_pat", return_value="offline-pat") as pat:
            self.assertEqual(authorization("example"), "Basic Om9mZmxpbmUtcGF0")
        pat.assert_called_once_with("example")

    def test_native_helper_output_preserves_unicode_despite_inherited_encoding(self):
        invocation = azure_cli_invocation(
            ["az", "account"], platform="win32", find=lambda _: r"C:\Azure CLI\wbin\az.cmd",
            exists=lambda _: True,
        )
        with patch.dict(os.environ, {"PYTHONIOENCODING": "cp1252"}):
            output = ado.run([
                sys.executable, *invocation[1:3], "-I", "-B", "-c",
                "import sys; print(sys.flags.utf8_mode); print('\\u65e5\\u672c\\u8a9e \\U0001f916')",
            ])
        self.assertEqual(output, "1\n\u65e5\u672c\u8a9e \U0001f916")

    def test_bridge_json_survives_non_utf8_windows_pipe_encoding(self):
        spec = importlib.util.spec_from_file_location("bridge_encoding_test", SCRIPTS / "ado-bridge.py")
        bridge = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(bridge)
        raw = io.BytesIO()
        output = io.TextIOWrapper(raw, encoding="cp1252")
        request = {
            "operation": "read", "org": "example", "project": "\u65e5\u672c\u8a9e",
            "resource": "item", "repositoryId": "repo", "path": "/\U0001f916.py", "commit": "a" * 40,
        }
        source = io.TextIOWrapper(
            io.BytesIO(json.dumps(request, ensure_ascii=False).encode("utf-8")), encoding="cp1252",
        )
        expected = {"title": "Unicode \U0001f916 and \u65e5\u672c\u8a9e"}
        with patch.object(bridge, "dispatch", return_value=expected) as dispatch, \
             patch.object(bridge.sys, "stdin", source), redirect_stdout(output):
            self.assertEqual(bridge.main(), 0)
        dispatch.assert_called_once_with(request)
        output.flush()
        self.assertEqual(json.loads(raw.getvalue().decode("utf-8")), expected)

    def test_snapshot_cli_json_survives_non_utf8_windows_pipe_encoding(self):
        spec = importlib.util.spec_from_file_location("pr_cli_encoding_test", SCRIPTS / "ado-pr.py")
        cli = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(cli)
        raw = io.BytesIO()
        output = io.TextIOWrapper(raw, encoding="cp1252")
        expected = {"title": "\u65e5\u672c\u8a9e \U0001f916"}
        with patch("shared.pr.PrClient") as client, \
             patch.object(cli.sys, "argv", ["ado-pr.py", "snapshot", "--id", "42", "--org", "example"]), \
             redirect_stdout(output):
            client.return_value.snapshot.return_value = expected
            cli.main()
        output.flush()
        self.assertEqual(json.loads(raw.getvalue().decode("utf-8")), expected)


if __name__ == "__main__":
    unittest.main()
