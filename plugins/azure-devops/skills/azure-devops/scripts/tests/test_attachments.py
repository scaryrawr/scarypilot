from __future__ import annotations

import argparse
import importlib.util
import json
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from io import StringIO
from pathlib import Path
from unittest.mock import patch

SCRIPTS = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SCRIPTS))

from shared.ado import (  # noqa: E402
    AI_ATTRIBUTION,
    attachment_markdown,
    build_thread_payload,
    upload_pr_attachment,
)


def load_script(name: str):
    spec = importlib.util.spec_from_file_location(name.replace("-", "_"), SCRIPTS / name)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


make_pr = load_script("make-pr.py")
ATTACHMENT_URL = (
    "https://dev.azure.com/example/project/_apis/git/repositories/repo/"
    "pullRequests/42/attachments/demo.mp4"
)


class AttachmentTests(unittest.TestCase):
    def test_videos_use_inline_player_with_controls_and_no_autoplay(self):
        for name in ("demo.mp4", "demo.MP4", "demo.mov", "demo.webm"):
            with self.subTest(name=name):
                self.assertEqual(
                    attachment_markdown(name, ATTACHMENT_URL),
                    f'<video src="{ATTACHMENT_URL}" controls width="800"></video>',
                )

    def test_images_use_inline_markdown_and_other_files_remain_links(self):
        for name in ("demo.png", "demo.PNG", "demo.jpg", "demo.jpeg", "demo.gif", "demo.webp"):
            with self.subTest(name=name):
                self.assertEqual(attachment_markdown(name, ATTACHMENT_URL), f"![{name}]({ATTACHMENT_URL})")
        for name in ("report.pdf", "logs.zip", "demo.mp4.gz", "demo.png.gz", "unknown"):
            with self.subTest(name=name):
                self.assertEqual(attachment_markdown(name, ATTACHMENT_URL), f"[{name}]({ATTACHMENT_URL})")

    def test_video_url_is_html_escaped(self):
        url = f'{ATTACHMENT_URL}?api-version=7.1&name="demo"'
        self.assertEqual(
            attachment_markdown("demo.mp4", url),
            f'<video src="{ATTACHMENT_URL}?api-version=7.1&amp;name=&quot;demo&quot;" controls width="800"></video>',
        )

    def test_markdown_escapes_filename_and_url_delimiters(self):
        self.assertEqual(
            attachment_markdown("screen[1]\\<test>\n.png", f"{ATTACHMENT_URL}/screen (1).png"),
            f"![screen\\[1\\]\\\\\\<test\\> .png]({ATTACHMENT_URL}/screen%20%281%29.png)",
        )

    def test_every_upload_command_returns_shared_markup_and_preserves_metadata(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "recording.bin"
            path.write_bytes(b"media bytes")
            for script_name in ("ado-cli.py", "make-pr.py", "review-pr.py"):
                for file_name in ("demo.mp4", "screenshot.png", "logs.zip"):
                    with self.subTest(script=script_name, file_name=file_name):
                        script = load_script(script_name)
                        output = StringIO()
                        with (
                            patch("shared.ado.token", return_value="test-token"),
                            patch("shared.ado.request_json", return_value={"id": "attachment", "url": ATTACHMENT_URL}) as request,
                            patch.object(sys, "argv", [
                                script_name, "upload-attachment", "--org", "example",
                                "--project", "project", "--repository-id", "repo",
                                "--pull-request-id", "42", "--file", str(path), "--file-name", file_name,
                            ]),
                            redirect_stdout(output),
                        ):
                            script.main()
                        metadata = json.loads(output.getvalue())
                        self.assertEqual(metadata, {
                            "fileName": file_name,
                            "filePath": str(path),
                            "id": "attachment",
                            "url": ATTACHMENT_URL,
                            "markdown": attachment_markdown(file_name, ATTACHMENT_URL),
                        })
                        self.assertEqual(request.call_args.kwargs["body"], b"media bytes")
                        self.assertEqual(request.call_args.kwargs["method"], "POST")
                        self.assertIn(f"/attachments/{file_name}?api-version=7.1", request.call_args.args[0])

    def test_upload_uses_local_filename_by_default(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "screenshot.png"
            path.write_bytes(b"media bytes")
            with (
                patch("shared.ado.token", return_value="test-token"),
                patch("shared.ado.request_json", return_value={"url": ATTACHMENT_URL}),
            ):
                metadata = upload_pr_attachment(
                    org="example", project="project", repository_id="repo",
                    pull_request_id="42", file=str(path),
                )
            self.assertEqual(metadata["markdown"], f"![screenshot.png]({ATTACHMENT_URL})")

    def test_missing_attachment_url_is_an_explicit_failure(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "demo.mp4"
            path.write_bytes(b"media bytes")
            for url in (None, "", 42):
                with (
                    self.subTest(url=url),
                    patch("shared.ado.token", return_value="test-token"),
                    patch("shared.ado.request_json", return_value={"url": url}),
                    self.assertRaisesRegex(SystemExit, "attachment upload response did not include a URL"),
                ):
                    upload_pr_attachment(
                        org="example", project="project", repository_id="repo",
                        pull_request_id="42", file=str(path),
                    )

    def test_submitted_description_and_comment_preserve_inline_media_and_attribution(self):
        video = attachment_markdown("demo.mp4", ATTACHMENT_URL)
        image = attachment_markdown("screenshot.png", f"{ATTACHMENT_URL}/screenshot.png")
        content = f"## Demo\n\n{video}\n\n{image}"
        expected = f"{content}\n\n{AI_ATTRIBUTION}"
        args = argparse.Namespace(
            org="example", project="project", repository="repo", repository_id="",
            source_branch="feature", target_branch="main", title="Title",
            description=content, description_file="", draft=False, user_authored=False,
        )
        with (
            patch.object(make_pr, "request_json", return_value={"pullRequestId": 42}) as request,
            redirect_stdout(StringIO()),
        ):
            make_pr.create_pr(args)
        self.assertEqual(json.loads(request.call_args.kwargs["body"])["description"], expected)
        for file_path in ("", "src/a.py"):
            with self.subTest(file_path=file_path):
                payload = build_thread_payload(argparse.Namespace(
                    content=expected, status="active", file_path=file_path,
                    line_start=2, line_end=None, user_authored=False,
                ))
                self.assertEqual(payload["comments"][0]["content"], expected)


if __name__ == "__main__":
    unittest.main()
