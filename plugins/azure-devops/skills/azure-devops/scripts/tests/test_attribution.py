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

from shared.ado import AI_ATTRIBUTION, attribute_ai_text, build_thread_payload  # noqa: E402


def load_script(name: str):
    spec = importlib.util.spec_from_file_location(name.replace("-", "_"), SCRIPTS / name)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


ado_pr = load_script("ado-pr.py")
make_pr = load_script("make-pr.py")


class AttributionTests(unittest.TestCase):
    def test_text_suffix_is_idempotent_and_migrates_legacy_suffix(self):
        expected = f"Finding\n\n{AI_ATTRIBUTION}"
        self.assertEqual(attribute_ai_text("Finding"), expected)
        self.assertEqual(attribute_ai_text(expected), expected)
        self.assertEqual(attribute_ai_text("Finding\n\n🤖 Generated with AI"), expected)
        self.assertEqual(attribute_ai_text(""), "")

    def test_new_thread_payload_attributes_inline_and_top_level_comments(self):
        for file_path in ("src/a.py", ""):
            with self.subTest(file_path=file_path):
                payload = build_thread_payload(argparse.Namespace(
                    content="Finding", status="active", file_path=file_path,
                    line_start=2 if file_path else None, line_end=None, user_authored=False,
                ))
                self.assertEqual(payload["comments"][0]["content"], f"Finding\n\n{AI_ATTRIBUTION}")
                self.assertEqual("threadContext" in payload, bool(file_path))

    def test_user_authored_thread_is_not_attributed(self):
        payload = build_thread_payload(argparse.Namespace(
            content="Post this verbatim.", status="active", file_path="",
            line_start=None, line_end=None, user_authored=True,
        ))
        self.assertEqual(payload["comments"][0]["content"], "Post this verbatim.")

    def test_reply_is_attributed_before_post_and_resolves_after_reply(self):
        args = argparse.Namespace(id="42", thread_id="7", content="Fixed", status="fixed", user_authored=False)
        calls = []

        def invoke(*_args, **kwargs):
            calls.append(kwargs)
            return {"id": len(calls)}

        with patch.object(ado_pr, "invoke_thread_api", side_effect=invoke):
            ado_pr.reply_and_resolve(args)

        self.assertEqual(calls[0]["payload"]["content"], f"Fixed\n\n{AI_ATTRIBUTION}")
        self.assertEqual(calls[0]["method"], "POST")
        self.assertEqual(calls[1]["method"], "PATCH")

        args.user_authored = True
        calls.clear()
        with patch.object(ado_pr, "invoke_thread_api", side_effect=invoke):
            ado_pr.reply_and_resolve(args)
        self.assertEqual(calls[0]["payload"]["content"], "Fixed")

    def test_pr_description_is_attributed_in_rest_body_and_limit_includes_suffix(self):
        args = argparse.Namespace(
            org="example", project="project", repository="repo", repository_id="",
            source_branch="feature", target_branch="main", title="Title",
            description="Summary", description_file="", draft=False, user_authored=False,
        )
        output = StringIO()
        with patch.object(make_pr, "request_json", return_value={"pullRequestId": 42}) as request, redirect_stdout(output):
            make_pr.create_pr(args)
        body = json.loads(request.call_args.kwargs["body"])
        self.assertEqual(body["description"], f"Summary\n\n{AI_ATTRIBUTION}")
        self.assertEqual(body["title"], "Title")
        self.assertEqual(json.loads(output.getvalue())["descriptionLength"], 31)

        args.user_authored = True
        self.assertEqual(make_pr.read_description(args), "Summary")
        args.user_authored = False
        args.description = "x" * 3976
        self.assertEqual(make_pr.utf16_length(make_pr.read_description(args)), make_pr.PR_DESCRIPTION_MAX)
        args.description += "x"
        with self.assertRaisesRegex(SystemExit, "4001 UTF-16 code units"):
            make_pr.read_description(args)

        args.description = "🤖" * 2001
        with self.assertRaisesRegex(SystemExit, "4026 UTF-16 code units"):
            make_pr.read_description(args)

        args.user_authored = True
        args.description = "🤖" * 2000
        self.assertEqual(make_pr.utf16_length(make_pr.read_description(args)), make_pr.PR_DESCRIPTION_MAX)
        args.description += "🤖"
        with self.assertRaisesRegex(SystemExit, "4002 UTF-16 code units"):
            make_pr.read_description(args)

    def test_file_description_preserves_template_sections_and_existing_suffix(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "description.md"
            path.write_text(f"## What\n\nDetail\n\n{AI_ATTRIBUTION}\n", encoding="utf-8")
            args = argparse.Namespace(description_file=str(path), description=None, user_authored=False)
            self.assertEqual(make_pr.read_description(args), f"## What\n\nDetail\n\n{AI_ATTRIBUTION}")


if __name__ == "__main__":
    unittest.main()
