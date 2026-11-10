import argparse
from array import array
import importlib.util
from pathlib import Path
import struct
import tempfile
import types
import unittest
from unittest.mock import Mock, patch
import wave


SCRIPT = Path(__file__).resolve().parents[1] / "skills" / "kokoro" / "scripts" / "kokoro.py"
SPEC = importlib.util.spec_from_file_location("kokoro_helper", SCRIPT)
helper = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(helper)


class KokoroTests(unittest.TestCase):
    def test_wav_clips_samples_and_uses_returned_rate(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "clip.wav"
            result = helper.write_wav(output, [-2, -0.5, 0, 0.5, 2], 24000)
            with wave.open(str(output), "rb") as audio:
                self.assertEqual((audio.getnchannels(), audio.getsampwidth()), (1, 2))
                self.assertEqual((audio.getframerate(), audio.getnframes()), (24000, 5))
                self.assertEqual(
                    struct.unpack("=5h", audio.readframes(5)),
                    (-32767, -16384, 0, 16384, 32767),
                )
            self.assertEqual(result["duration_seconds"], 5 / 24000)

    def test_big_endian_samples_are_converted_once_by_wave(self):
        class BigEndianArray(array):
            def tobytes(self):
                return struct.pack(f">{len(self)}h", *self)

        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "clip.wav"
            with patch.object(helper, "array", BigEndianArray), patch.object(
                helper.sys, "byteorder", "big"
            ):
                helper.write_wav(output, [0.25, -0.5], 24000)
            self.assertEqual(output.read_bytes()[-4:], struct.pack("<2h", 8192, -16384))

    def test_exclusive_write_preserves_existing_output(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "clip.wav"
            output.write_bytes(b"keep this")
            with self.assertRaises(FileExistsError):
                helper.write_wav(output, [0.1], 24000)
            self.assertEqual(output.read_bytes(), b"keep this")

    def test_invalid_audio_never_creates_output(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "clip.wav"
            for samples, rate in (([], 24000), ([float("nan")], 24000),
                                  ([float("inf")], 24000), ([0], 0), ([0], 1.5)):
                with self.subTest(samples=samples, rate=rate):
                    with self.assertRaises(ValueError):
                        helper.write_wav(output, samples, rate)
                    self.assertFalse(output.exists())

    def test_speed_bounds(self):
        for value in ("0", "-1", "nan", "inf", "0.49", "2.01"):
            with self.subTest(value=value):
                with self.assertRaises(argparse.ArgumentTypeError):
                    helper.speech_speed(value)
        for value in ("0.5", "1.03", "2"):
            self.assertEqual(helper.speech_speed(value), float(value))

    def test_synthesis_reads_utf8_and_passes_voice_controls(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            model, voices, text = root / "model.onnx", root / "voices.bin", root / "text.txt"
            model.touch()
            voices.touch()
            text.write_text("Narration from a file.", encoding="utf-8")
            constructor = Mock()
            engine = constructor.from_session.return_value
            engine.create.return_value = ([0.0, 0.5], 24000)
            engine.sess.get_providers.return_value = ["CPUExecutionProvider"]
            session = Mock()
            args = argparse.Namespace(
                model=model, voices=voices, output=root / "clip.wav",
                text=None, text_file=text, voice="af_heart", speed=1.03, lang="en-us",
            )
            with patch.dict("sys.modules", {
                "kokoro_onnx": types.SimpleNamespace(Kokoro=constructor),
                "onnxruntime": types.SimpleNamespace(InferenceSession=session),
            }):
                result = helper.synthesize(args)
                session.assert_called_once_with(str(model), providers=["CPUExecutionProvider"])
                constructor.from_session.assert_called_once_with(session.return_value, str(voices))
                engine.create.assert_called_once_with(
                    "Narration from a file.", voice="af_heart", speed=1.03, lang="en-us"
                )
                self.assertEqual(result["frames"], 2)
                self.assertEqual(result["session_providers"], ["CPUExecutionProvider"])
                constructor.reset_mock()
                session.reset_mock()
                with self.assertRaises(FileExistsError):
                    helper.synthesize(args)
                constructor.from_session.assert_not_called()
                session.assert_not_called()
                args.output = root / "empty.wav"
                text.write_text(" \n", encoding="utf-8")
                with self.assertRaisesRegex(ValueError, "empty"):
                    helper.synthesize(args)
                constructor.from_session.assert_not_called()
                session.assert_not_called()

    def test_missing_inputs_and_output_directory_fail_before_loading_model(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            args = argparse.Namespace(
                model=root / "model", voices=root / "voices", output=root / "clip.wav",
                text="hello", text_file=None, voice="af_heart", speed=1, lang="en-us",
            )
            with self.assertRaisesRegex(ValueError, "asset is not a file"):
                helper.synthesize(args)
            args.model.touch()
            args.voices.touch()
            args.output = root / "missing" / "clip.wav"
            with self.assertRaisesRegex(ValueError, "output directory"):
                helper.synthesize(args)
            self.assertFalse(args.output.exists())

    def test_dangling_output_symlink_is_preserved(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            link = root / "clip.wav"
            target = root / "missing.wav"
            try:
                link.symlink_to(target)
            except OSError as error:
                self.skipTest(f"symlink creation unavailable: {error}")
            with self.assertRaises(FileExistsError):
                helper.write_wav(link, [0.1], 24000)
            self.assertTrue(link.is_symlink())
            self.assertFalse(target.exists())

    def test_cli_requires_exactly_one_text_source(self):
        base = ["synthesize", "--model", "m", "--voices", "v", "--output", "o"]
        for sources in ([], ["--text", "hello", "--text-file", "script.txt"]):
            with self.subTest(sources=sources), patch("sys.stderr"):
                with self.assertRaises(SystemExit) as error:
                    helper.main(base + sources)
                self.assertEqual(error.exception.code, 2)


if __name__ == "__main__":
    unittest.main()
