from __future__ import annotations

import argparse
import importlib.util
import json
import sys
import tempfile
import unittest
from copy import deepcopy
from contextlib import redirect_stdout
from io import StringIO
from pathlib import Path
from unittest.mock import patch
from urllib.parse import quote, urljoin

SCRIPTS = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SCRIPTS))

from shared.ado import (  # noqa: E402
    AI_ATTRIBUTION,
    attachment_markdown,
    build_thread_payload,
    upload_pr_attachment,
    video_markdown,
)
from shared.transport import AdoError  # noqa: E402


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
PROJECT_ID = "11111111-1111-1111-1111-111111111111"
REPOSITORY_ID = "22222222-2222-2222-2222-222222222222"
PAGE_URL = "https://dev.azure.com/example/Project/_git/repo/pullrequest/42"
LEGACY_PAGE_URL = "https://example.visualstudio.com/DefaultCollection/Project/_git/repo/pullRequest/42"
PR_DETAILS = {
    "pullRequestId": 42,
    "repository": {
        "id": REPOSITORY_ID, "name": "repo",
        "project": {"id": PROJECT_ID, "name": "Project"},
    },
}


def uploaded_video_url(file_name="demo.mp4", project="Project"):
    return (
        f"https://dev.azure.com/example/{quote(project, safe='')}/_apis/git/repositories/"
        f"{REPOSITORY_ID}/pullRequests/42/attachments/{quote(file_name, safe='')}"
    )


def relative_video_markup(file_name="demo.mp4"):
    return (
        f'<video src="../../../_apis/git/repositories/{REPOSITORY_ID}/pullRequests/'
        f'42/attachments/{quote(file_name, safe="")}" controls width="800"></video>'
    )


def format_video(**updates):
    arguments = {
        "org": "example", "project": "Project", "repository_id": "repo",
        "pull_request_id": "42", "pr_page_url": PAGE_URL,
        "file_name": "demo.mp4", "url": uploaded_video_url(),
    }
    return video_markdown(**(arguments | updates))


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

    def test_webp_images_do_not_depend_on_host_mime_registration(self):
        with patch("shared.ado.mimetypes.guess_type", return_value=(None, None)):
            for name in ("demo.webp", "demo.WEBP"):
                self.assertEqual(attachment_markdown(name, ATTACHMENT_URL), f"![{name}]({ATTACHMENT_URL})")

    def test_markdown_escapes_filename_and_url_delimiters(self):
        self.assertEqual(
            attachment_markdown("screen[1]\\<test>\n.png", f"{ATTACHMENT_URL}/screen (1).png"),
            f"![screen\\[1\\]\\\\\\<test\\> .png]({ATTACHMENT_URL}/screen%20%281%29.png)",
        )

    def test_every_upload_command_returns_shared_markup_and_preserves_metadata(self):
        with tempfile.TemporaryDirectory(dir=Path.cwd()) as directory:
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
                        self.assertEqual(request.call_count, 1)
                        self.assertIn(f"/attachments/{file_name}?api-version=7.1", request.call_args.args[0])

    def test_upload_uses_local_filename_by_default(self):
        with tempfile.TemporaryDirectory(dir=Path.cwd()) as directory:
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
        with tempfile.TemporaryDirectory(dir=Path.cwd()) as directory:
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


class ProjectRelativeVideoTests(unittest.TestCase):
    def test_canonical_and_legacy_pages_resolve_to_project_attachment_endpoint(self):
        for page in (PAGE_URL, LEGACY_PAGE_URL, PAGE_URL.replace("pullrequest", "PuLlReQuEsT")):
            with self.subTest(page=page), patch("shared.ado.request_json", return_value=PR_DETAILS) as request:
                result = format_video(pr_page_url=page)
                self.assertEqual(result, {"url": uploaded_video_url(), "markdown": relative_video_markup()})
                source = result["markdown"].split('"')[1]
                expected = uploaded_video_url()
                if "visualstudio.com" in page:
                    expected = expected.replace(
                        "dev.azure.com/example", "example.visualstudio.com/DefaultCollection",
                    )
                self.assertEqual(urljoin(page, source), expected)
                self.assertEqual(request.call_args.args[0], (
                    "https://dev.azure.com/example/Project/_apis/git/repositories/repo/pullRequests/42?api-version=7.1"
                ))
                self.assertNotIn("method", request.call_args.kwargs)

    def test_filename_encoding_and_absolute_url_preservation(self):
        for name in ("space name.mp4", "hash#.mp4", "query?.mp4", "100%.mp4", "café 日本語.MP4", "quote\"&.mp4"):
            with self.subTest(name=name), patch("shared.ado.request_json", return_value=PR_DETAILS):
                absolute = uploaded_video_url(name)
                result = format_video(file_name=name, url=absolute)
                self.assertEqual(result["url"], absolute)
                self.assertEqual(result["markdown"], relative_video_markup(name))
                self.assertEqual(urljoin(PAGE_URL, result["markdown"].split('"')[1]), absolute)

    def test_project_and_repository_name_or_guid_aliases(self):
        for project_arg in ("Project", PROJECT_ID):
            for page_project in ("Project", PROJECT_ID):
                for api_project in ("Project", PROJECT_ID):
                    for repository in ("repo", REPOSITORY_ID):
                        with (
                            self.subTest(project=project_arg, page=page_project, api=api_project, repo=repository),
                            patch("shared.ado.request_json", return_value=PR_DETAILS) as request,
                        ):
                            absolute = uploaded_video_url(project=api_project)
                            page = PAGE_URL.replace("/Project/", f"/{page_project}/").replace("/repo/", f"/{repository}/")
                            result = format_video(
                                project=project_arg, repository_id=repository, pr_page_url=page, url=absolute,
                            )
                            self.assertEqual(result, {"url": absolute, "markdown": relative_video_markup()})
                            self.assertIn(f"/{project_arg}/_apis/", request.call_args.args[0])

    def test_normalized_organization_and_https_443_are_supported(self):
        with patch("shared.ado.request_json", return_value=PR_DETAILS):
            absolute = uploaded_video_url().replace("dev.azure.com", "DEV.AZURE.COM:443")
            result = format_video(
                org="https://dev.azure.com/EXAMPLE",
                pr_page_url=PAGE_URL.replace("dev.azure.com", "DEV.AZURE.COM:443"), url=absolute,
            )
            self.assertEqual(result, {"url": absolute, "markdown": relative_video_markup()})

    def test_metadata_identity_and_completeness_must_match_arguments(self):
        for path, bad_value in (
            (("pullRequestId",), 43), (("pullRequestId",), True),
            (("repository", "id"), "33333333-3333-3333-3333-333333333333"),
            (("repository", "id"), "repo"), (("repository", "id"), None),
            (("repository", "name"), "other"), (("repository", "name"), None),
            (("repository", "project", "id"), None),
            (("repository", "project", "name"), "Other"), (("repository", "project", "name"), None),
        ):
            details = deepcopy(PR_DETAILS)
            item = details
            for key in path[:-1]:
                item = item[key]
            item[path[-1]] = bad_value
            with self.subTest(path=path, value=bad_value), patch("shared.ado.request_json", return_value=details):
                with self.assertRaises(AdoError):
                    format_video(repository_id=REPOSITORY_ID)
        for details in (None, [], {}, {"pullRequestId": 42, "repository": []}):
            with self.subTest(details=details), patch("shared.ado.request_json", return_value=details):
                with self.assertRaises(AdoError):
                    format_video()

    def test_argument_and_page_identity_mismatches_fail(self):
        for updates in (
            {"project": "Other"}, {"repository_id": "other"}, {"pull_request_id": "0"},
            {"pull_request_id": "-1"}, {"pull_request_id": True}, {"org": "other"},
            {"pull_request_id": "²"}, {"pull_request_id": "٤٢"}, {"pull_request_id": "042"},
            {"pr_page_url": PAGE_URL.replace("/Project/", "/Other/")},
            {"pr_page_url": PAGE_URL.replace("/repo/", "/other/")},
            {"pr_page_url": PAGE_URL.replace("/42", "/43")},
        ):
            with self.subTest(updates=updates), patch("shared.ado.request_json", return_value=PR_DETAILS):
                with self.assertRaises(AdoError):
                    format_video(**updates)

    def test_unsupported_and_unsafe_page_urls_are_rejected_before_any_io(self):
        invalid_pages = [
            PAGE_URL + "/", PAGE_URL + "/files", PAGE_URL + "?view=files", PAGE_URL + "#discussion",
            PAGE_URL + "?", PAGE_URL + "#", PAGE_URL.replace("/Project", "", 1),
            PAGE_URL.replace("/repo/", "/_optimized/repo/"),
            PAGE_URL.replace("https:", "http:"), PAGE_URL.replace("dev.azure.com", "evil.example"),
            PAGE_URL.replace("/example/", "/other/"),
            PAGE_URL.replace("dev.azure.com", "dev.azure.com.evil.example"),
            PAGE_URL.replace("dev.azure.com", "user@dev.azure.com"),
            PAGE_URL.replace("dev.azure.com", "user:pass@dev.azure.com"),
            PAGE_URL.replace("dev.azure.com", "dev.azure.com:444"),
            PAGE_URL.replace("dev.azure.com", "dev.azure.com:bad"),
            PAGE_URL.replace("dev.azure.com", "[broken"),
            PAGE_URL.replace("/Project/", "/../"), PAGE_URL.replace("/Project/", "/%2e%2e/"),
            PAGE_URL.replace("/Project/", "/Pro%2fject/"), PAGE_URL.replace("/Project/", "/Pro%5cject/"),
            PAGE_URL.replace("/Project/", "/Pro%252fject/"), PAGE_URL.replace("/Project/", "/%252e%252e/"),
            PAGE_URL.replace("/Project/", "/Pro%0Aject/"), PAGE_URL.replace("/Project/", "/Pro%7fject/"),
            PAGE_URL.replace("/Project/", "/Pro%GGject/"), PAGE_URL.replace("/Project/", "/Pro%FFject/"),
            PAGE_URL.replace("/Project/", "//Project/"), PAGE_URL.replace("/Project/", "\\Project/"),
            PAGE_URL.replace("https://", "https:///"), "\n" + PAGE_URL, PAGE_URL + "\t",
            LEGACY_PAGE_URL.replace("/DefaultCollection", ""),
            LEGACY_PAGE_URL.replace("example.visualstudio.com", "other.visualstudio.com"),
        ]
        for page in invalid_pages:
            with self.subTest(page=page), patch("shared.ado.request_json") as request:
                with self.assertRaisesRegex(AdoError, "exact HTTPS PR page URL"):
                    format_video(pr_page_url=page)
                request.assert_not_called()

    def test_attachment_url_requires_exact_authenticated_identity_and_filename(self):
        absolute = uploaded_video_url()
        for url in (
            absolute.replace("/example/", "/other/"), absolute.replace("/Project/", "/Other/"),
            absolute.replace(REPOSITORY_ID, "33333333-3333-3333-3333-333333333333"),
            absolute.replace(REPOSITORY_ID, "repo"), absolute.replace("/42/", "/43/"),
            absolute.replace("demo.mp4", "different.mp4"), absolute + "/extra", absolute + "/",
            absolute + "?api-version=7.1", absolute + "#video", absolute + "?", absolute + "#",
            absolute.replace("dev.azure.com", "evil.example"), absolute.replace("https:", "http:"),
            absolute.replace("dev.azure.com", "user@dev.azure.com"),
            absolute.replace("dev.azure.com", "dev.azure.com:444"),
            absolute.replace("/Project/", "/%2e%2e/"),
            absolute.replace("/Project/", "/Pro%2fject/"),
            absolute.replace("demo.mp4", "demo%2f.mp4"),
            absolute.replace("demo.mp4", "demo%5c.mp4"),
            absolute.replace("demo.mp4", "demo%252f.mp4"),
            absolute.replace("demo.mp4", "demo%00.mp4"),
            absolute.replace("demo.mp4", "demo%GG.mp4"),
            absolute.replace("dev.azure.com/example", "example.visualstudio.com/DefaultCollection"),
            absolute.replace("/Project/", "\\Project/"), "\n" + absolute,
        ):
            with self.subTest(url=url), patch("shared.ado.request_json", return_value=PR_DETAILS) as request:
                with self.assertRaises(AdoError):
                    format_video(url=url)
                self.assertEqual(request.call_count, 1)
                self.assertNotEqual(request.call_args.args[0], url)

    def test_formatter_rejects_nonvideo_and_unsafe_filenames_without_io(self):
        for name in ("image.png", "logs.zip", "demo.mp4.gz", "", "../demo.mp4", "a\\demo.mp4", "a\n.mp4"):
            with self.subTest(name=name), patch("shared.ado.request_json") as request:
                with self.assertRaises(AdoError):
                    format_video(file_name=name)
                request.assert_not_called()

    def test_video_markdown_cli_is_read_only_and_requires_no_local_file(self):
        script = load_script("ado-cli.py")
        output = StringIO()
        with (
            patch("shared.ado.request_json", return_value=PR_DETAILS) as request,
            patch.object(sys, "argv", [
                "ado-cli.py", "video-markdown", "--org", "example", "--project", "Project",
                "--repository-id", "repo", "--pull-request-id", "42", "--pr-page-url", LEGACY_PAGE_URL,
                "--file-name", "demo.mp4", "--url", uploaded_video_url(),
            ]),
            redirect_stdout(output),
        ):
            script.main()
        self.assertEqual(json.loads(output.getvalue()), {
            "url": uploaded_video_url(), "markdown": relative_video_markup(),
        })
        self.assertEqual(request.call_count, 1)
        self.assertNotIn("body", request.call_args.kwargs)

    def test_video_markdown_cli_rejects_nonvideo_and_untrusted_urls(self):
        script = load_script("ado-cli.py")
        for name, url in (("image.png", uploaded_video_url()), ("demo.mp4", "https://evil.example/demo.mp4")):
            output = StringIO()
            with (
                self.subTest(name=name, url=url),
                patch("shared.ado.request_json", return_value=PR_DETAILS) as request,
                patch.object(sys, "argv", [
                    "ado-cli.py", "video-markdown", "--org", "example", "--project", "Project",
                    "--repository-id", "repo", "--pull-request-id", "42", "--pr-page-url", PAGE_URL,
                    "--file-name", name, "--url", url,
                ]),
                redirect_stdout(output), self.assertRaises(AdoError),
            ):
                script.main()
            self.assertEqual(output.getvalue(), "")
            self.assertTrue(all(call.kwargs.get("method", "GET") == "GET" for call in request.call_args_list))

    def test_all_upload_commands_opt_in_and_preserve_absolute_metadata(self):
        with tempfile.TemporaryDirectory(dir=Path.cwd()) as directory:
            path = Path(directory) / "demo.mp4"
            path.write_bytes(b"video")
            for script_name in ("ado-cli.py", "make-pr.py", "review-pr.py"):
                script = load_script(script_name)
                output = StringIO()
                with (
                    self.subTest(script=script_name),
                    patch("shared.ado.request_json", side_effect=[
                        PR_DETAILS, {"id": "attachment", "url": uploaded_video_url()},
                    ]) as request,
                    patch.object(sys, "argv", [
                        script_name, "upload-attachment", "--org", "example", "--project", "Project",
                        "--repository-id", "repo", "--pull-request-id", "42", "--file", str(path),
                        "--pr-page-url", PAGE_URL,
                    ]),
                    redirect_stdout(output),
                ):
                    script.main()
                self.assertEqual(json.loads(output.getvalue()), {
                    "fileName": "demo.mp4", "filePath": str(path), "id": "attachment",
                    "url": uploaded_video_url(), "markdown": relative_video_markup(),
                })
                self.assertEqual(request.call_count, 2)
                self.assertEqual(request.call_args_list[0].kwargs.get("method", "GET"), "GET")
                self.assertEqual(request.call_args_list[1].kwargs["method"], "POST")
                self.assertEqual(request.call_args_list[1].kwargs["body"], b"video")
                self.assertEqual(request.call_args_list[1].args[0], (
                    f"https://dev.azure.com/example/{PROJECT_ID}/_apis/git/repositories/"
                    f"{REPOSITORY_ID}/pullRequests/42/attachments/demo.mp4?api-version=7.1"
                ))

    def test_all_upload_commands_reject_identity_mismatch_before_post(self):
        with tempfile.TemporaryDirectory(dir=Path.cwd()) as directory:
            path = Path(directory) / "demo.mp4"
            path.write_bytes(b"video")
            for script_name in ("ado-cli.py", "make-pr.py", "review-pr.py"):
                for page in (PAGE_URL.replace("/repo/", "/other/"), PAGE_URL + "/"):
                    script = load_script(script_name)
                    output = StringIO()
                    with (
                        self.subTest(script=script_name, page=page),
                        patch("shared.ado.request_json", return_value=PR_DETAILS) as request,
                        patch.object(sys, "argv", [
                            script_name, "upload-attachment", "--org", "example", "--project", "Project",
                            "--repository-id", "repo", "--pull-request-id", "42", "--file", str(path),
                            "--pr-page-url", page,
                        ]),
                        redirect_stdout(output), self.assertRaises(AdoError),
                    ):
                        script.main()
                    self.assertEqual(output.getvalue(), "")
                    self.assertTrue(all(call.kwargs.get("method", "GET") == "GET" for call in request.call_args_list))

    def test_upload_rejects_returned_attachment_url_instead_of_falling_back(self):
        with tempfile.TemporaryDirectory(dir=Path.cwd()) as directory:
            path = Path(directory) / "demo.mp4"
            path.write_bytes(b"video")
            for response in ({"url": "https://evil.example/demo.mp4"}, {}, {"url": None}, []):
                with (
                    self.subTest(response=response),
                    patch("shared.ado.request_json", side_effect=[PR_DETAILS, response]),
                    self.assertRaises(AdoError),
                ):
                    upload_pr_attachment(
                        org="example", project="Project", repository_id="repo", pull_request_id="42",
                        file=str(path), pr_page_url=PAGE_URL,
                    )

    def test_nonvideo_uploads_ignore_page_context_without_additional_get(self):
        with tempfile.TemporaryDirectory(dir=Path.cwd()) as directory:
            path = Path(directory) / "media.bin"
            path.write_bytes(b"media")
            for script_name in ("ado-cli.py", "make-pr.py", "review-pr.py"):
                for name in ("image.png", "logs.zip"):
                    script = load_script(script_name)
                    output = StringIO()
                    with (
                        self.subTest(script=script_name, name=name),
                        patch("shared.ado.request_json", return_value={"id": "attachment", "url": ATTACHMENT_URL}) as request,
                        patch.object(sys, "argv", [
                            script_name, "upload-attachment", "--org", "example", "--project", "Project",
                            "--repository-id", "repo", "--pull-request-id", "42", "--file", str(path),
                            "--file-name", name, "--pr-page-url", "not a supported page",
                        ]),
                        redirect_stdout(output),
                    ):
                        script.main()
                    prefix = "!" if name == "image.png" else ""
                    self.assertEqual(json.loads(output.getvalue())["markdown"], f"{prefix}[{name}]({ATTACHMENT_URL})")
                    self.assertEqual(request.call_count, 1)
                    self.assertEqual(request.call_args.kwargs["method"], "POST")


if __name__ == "__main__":
    unittest.main()
