"""Local Kokoro synthesis with explicit assets and exclusive WAV output."""

import argparse
from array import array
import importlib.metadata
import json
import math
from pathlib import Path
import platform
import sys
import wave


def speech_speed(value):
    speed = float(value)
    if not math.isfinite(speed) or not 0.5 <= speed <= 2.0:
        raise argparse.ArgumentTypeError("speed must be finite and between 0.5 and 2.0")
    return speed


def pcm16(samples):
    frames = array("h")
    for sample in samples:
        value = float(sample)
        if not math.isfinite(value):
            raise ValueError("model returned a non-finite audio sample")
        frames.append(round(max(-1.0, min(1.0, value)) * 32767))
    if not frames:
        raise ValueError("model returned no audio samples")
    return frames.tobytes()


def write_wav(output, samples, sample_rate):
    if output.exists() or output.is_symlink():
        raise FileExistsError(f"refusing to overwrite output: {output}")
    rate = int(sample_rate)
    if rate <= 0 or rate != sample_rate:
        raise ValueError("model returned an invalid sample rate")
    data = pcm16(samples)
    with output.open("xb") as stream:
        with wave.open(stream, "wb") as audio:
            audio.setnchannels(1)
            audio.setsampwidth(2)
            audio.setframerate(rate)
            audio.writeframes(data)
    return {
        "output": str(output.resolve()),
        "sample_rate": rate,
        "frames": len(data) // 2,
        "duration_seconds": len(data) / (2 * rate),
    }


def doctor():
    import onnxruntime

    return {
        "python": platform.python_version(),
        "executable": sys.executable,
        "machine": platform.machine(),
        "platform": platform.platform(),
        "packages": {
            name: importlib.metadata.version(name)
            for name in ("kokoro-onnx", "numpy", "onnxruntime", "espeakng-loader")
        },
        "available_providers": onnxruntime.get_available_providers(),
        "provider_evidence": "Availability only; no model session or acceleration verified.",
    }


def synthesize(args):
    for asset in (args.model, args.voices):
        if not asset.is_file():
            raise ValueError(f"asset is not a file: {asset}")
    if args.output.exists() or args.output.is_symlink():
        raise FileExistsError(f"refusing to overwrite output: {args.output}")
    if not args.output.parent.is_dir():
        raise ValueError(f"output directory does not exist: {args.output.parent}")
    text = args.text if args.text is not None else args.text_file.read_text(encoding="utf-8")
    if not text.strip():
        raise ValueError("speech text must not be empty")

    import onnxruntime
    from kokoro_onnx import Kokoro

    session = onnxruntime.InferenceSession(
        str(args.model), providers=["CPUExecutionProvider"]
    )
    tts = Kokoro.from_session(session, str(args.voices))
    samples, sample_rate = tts.create(
        text, voice=args.voice, speed=args.speed, lang=args.lang
    )
    providers = tts.sess.get_providers()
    result = write_wav(args.output, samples, sample_rate)
    result["session_providers"] = providers
    return result


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("doctor", help="Report installed packages and provider availability")
    speech = commands.add_parser("synthesize", help="Write a new mono PCM16 WAV")
    speech.add_argument("--model", type=Path, required=True)
    speech.add_argument("--voices", type=Path, required=True)
    speech.add_argument("--output", type=Path, required=True)
    source = speech.add_mutually_exclusive_group(required=True)
    source.add_argument("--text")
    source.add_argument("--text-file", type=Path)
    speech.add_argument("--voice", default="af_heart")
    speech.add_argument("--lang", default="en-us")
    speech.add_argument("--speed", type=speech_speed, default=1.0)
    args = parser.parse_args(argv)
    try:
        result = doctor() if args.command == "doctor" else synthesize(args)
    except (OSError, ValueError, ImportError, importlib.metadata.PackageNotFoundError) as error:
        parser.exit(1, f"kokoro: {error}\n")
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
