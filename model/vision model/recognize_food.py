#!/usr/bin/env python3
"""Recognize food and estimated quantities in one JPEG, then write validated JSON."""
from __future__ import annotations

import argparse
import base64
import json
import os
import platform
import signal
import socket
import subprocess
import sys
import time
from io import BytesIO
from pathlib import Path
from typing import Any

try:
    import requests
except ImportError as exc:
    raise SystemExit(
        "Missing dependency 'requests'. Run:\n"
        "    python -m pip install -r requirements.txt"
    ) from exc

try:
    from PIL import Image, ImageOps, UnidentifiedImageError
except ImportError as exc:
    raise SystemExit(
        "Missing dependency 'Pillow'. Run:\n"
        "    python -m pip install -r requirements.txt"
    ) from exc

ROOT = Path(__file__).resolve().parent
CONFIG_PATH = ROOT / "artifacts.json"
WEIGHTS_DIR = ROOT / "weights"
RUNTIME_DIR = ROOT / "runtime"
OUTPUTS_DIR = ROOT / "outputs"
MAX_IMAGE_DIMENSION = 640
JPEG_QUALITY = 88


def load_config() -> dict[str, Any]:
    try:
        return json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise RuntimeError(f"Cannot read {CONFIG_PATH}: {exc}") from exc


def platform_key() -> str:
    system = platform.system().lower()
    machine = platform.machine().lower()
    if machine in {"arm64", "aarch64"}:
        arch = "arm64"
    elif machine in {"x86_64", "amd64"}:
        arch = "x64"
    else:
        arch = machine
    return f"{system}-{arch}"


def model_paths(config: dict[str, Any]) -> tuple[Path, Path]:
    files = config["model"]["files"]
    return WEIGHTS_DIR / files["model"]["filename"], WEIGHTS_DIR / files["mmproj"]["filename"]


def server_binary(config: dict[str, Any]) -> Path:
    override = os.environ.get("LLAMA_SERVER_PATH")
    if override:
        binary = Path(override).expanduser().resolve()
    else:
        key = platform_key()
        try:
            entry = config["llama_cpp"]["platforms"][key]
        except KeyError as exc:
            raise RuntimeError(
                f"No bundled runtime is configured for {key}. Set LLAMA_SERVER_PATH "
                "to a compatible llama-server binary."
            ) from exc
        release = config["llama_cpp"]["release"]
        binary = RUNTIME_DIR / f"llama-{release}-{key}" / entry["executable"]
    if not binary.is_file():
        raise FileNotFoundError(f"llama-server not found: {binary}\nRun: python setup.py")
    return binary


def free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def log_tail(path: Path, lines: int = 30) -> str:
    try:
        return "\n".join(path.read_text(encoding="utf-8", errors="replace").splitlines()[-lines:])
    except OSError:
        return "(server log unavailable)"


class LocalLlamaServer:
    """Start and reliably stop the pinned llama-server child process."""

    def __init__(self, config: dict[str, Any]) -> None:
        self.config = config
        self.process: subprocess.Popen[bytes] | None = None
        self.log_stream = None
        self.log_path = OUTPUTS_DIR / "llama-server.log"
        self.port = free_port()

    @property
    def url(self) -> str:
        return f"http://127.0.0.1:{self.port}"

    def __enter__(self) -> "LocalLlamaServer":
        model, mmproj = model_paths(self.config)
        missing = [str(path) for path in (model, mmproj) if not path.is_file()]
        if missing:
            raise FileNotFoundError("Missing model files:\n  " + "\n  ".join(missing) + "\nRun: python setup.py")

        binary = server_binary(self.config)
        server = self.config["server"]
        command = [
            str(binary),
            "--model", str(model),
            "--mmproj", str(mmproj),
            "--jinja",
            "--temp", "0",
            "--ctx-size", str(server["context_size"]),
            "--host", "127.0.0.1",
            "--port", str(self.port),
        ]

        OUTPUTS_DIR.mkdir(parents=True, exist_ok=True)
        self.log_stream = self.log_path.open("wb")
        process_kwargs: dict[str, Any] = {}
        if os.name == "nt":
            process_kwargs["creationflags"] = subprocess.CREATE_NEW_PROCESS_GROUP
        else:
            process_kwargs["start_new_session"] = True
        self.process = subprocess.Popen(
            command,
            cwd=binary.parent,
            stdin=subprocess.DEVNULL,
            stdout=self.log_stream,
            stderr=subprocess.STDOUT,
            **process_kwargs,
        )
        self._wait_until_ready(float(server["startup_timeout_seconds"]))
        return self

    def _wait_until_ready(self, timeout: float) -> None:
        assert self.process is not None
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            code = self.process.poll()
            if code is not None:
                if self.log_stream:
                    self.log_stream.flush()
                raise RuntimeError(
                    f"llama-server exited during startup with code {code}.\n"
                    f"Log: {self.log_path}\n{log_tail(self.log_path)}"
                )
            try:
                response = requests.get(f"{self.url}/health", timeout=2)
                if response.status_code == 200:
                    return
            except requests.RequestException:
                pass
            time.sleep(0.5)
        self.stop()
        raise TimeoutError(
            f"llama-server did not become ready within {timeout:.0f} seconds.\n"
            f"Log: {self.log_path}\n{log_tail(self.log_path)}"
        )

    def stop(self) -> None:
        process, self.process = self.process, None
        if process is not None and process.poll() is None:
            if os.name == "nt":
                process.send_signal(signal.CTRL_BREAK_EVENT)
            else:
                os.killpg(process.pid, signal.SIGTERM)
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                if os.name == "nt":
                    process.kill()
                else:
                    os.killpg(process.pid, signal.SIGKILL)
                process.wait()
        if self.log_stream is not None:
            self.log_stream.close()
            self.log_stream = None

    def __exit__(self, *_: object) -> None:
        self.stop()


def jpeg_data_uri(path: Path) -> str:
    """Load, orient, downsize, and re-encode an input JPEG for the vision model."""
    try:
        with Image.open(path) as source:
            source.load()
            if source.format != "JPEG":
                raise ValueError(f"Input must be a JPEG image: {path.name}")
            image = ImageOps.exif_transpose(source)
            image.thumbnail(
                (MAX_IMAGE_DIMENSION, MAX_IMAGE_DIMENSION),
                Image.Resampling.LANCZOS,
                reducing_gap=2.0,
            )
            if image.mode != "RGB":
                image = image.convert("RGB")
            encoded_image = BytesIO()
            image.save(encoded_image, format="JPEG", quality=JPEG_QUALITY, optimize=True)
    except (UnidentifiedImageError, OSError) as exc:
        raise ValueError(f"Could not read JPEG image {path}: {exc}") from exc

    encoded = base64.b64encode(encoded_image.getvalue()).decode("ascii")
    return f"data:image/jpeg;base64,{encoded}"


def system_prompt(language: str) -> str:
    language_name = {"en": "English", "de": "German"}[language]
    return (
        "You are Evora's on-device model. Task: meal.identify.image. "
        f"Language: {language} ({language_name}). Reply with the JSON object only."
    )


def user_prompt(hint: str | None) -> str:
    if not hint:
        return "Identify the meal in this image."
    return f"Identify the meal. Hint: {hint.strip().rstrip('.')}."


def request_payload(image: Path, language: str, hint: str | None, max_tokens: int) -> dict[str, Any]:
    return {
        "messages": [
            {"role": "system", "content": system_prompt(language)},
            {
                "role": "user",
                "content": [
                    {"type": "image_url", "image_url": {"url": jpeg_data_uri(image)}},
                    {"type": "text", "text": user_prompt(hint)},
                ],
            },
        ],
        "temperature": 0,
        "max_tokens": max_tokens,
        "stream": False,
        "response_format": {"type": "json_object"},
    }


def response_text(content: Any) -> str:
    """Extract text from standard or typed-part chat-completion content."""
    if isinstance(content, str):
        return content.strip()
    if isinstance(content, list) and content:
        parts: list[str] = []
        for part in content:
            if (
                not isinstance(part, dict)
                or part.get("type") not in {"text", "output_text"}
                or not isinstance(part.get("text"), str)
            ):
                raise RuntimeError("llama-server returned unsupported non-text content")
            parts.append(part["text"])
        return "".join(parts).strip()
    raise RuntimeError("llama-server response content was not text")


def call_server(url: str, payload: dict[str, Any], timeout: float) -> str:
    endpoint = url.rstrip("/") + "/v1/chat/completions"
    try:
        response = requests.post(endpoint, json=payload, timeout=timeout)
        response.raise_for_status()
        envelope = response.json()
        content = envelope["choices"][0]["message"]["content"]
    except requests.RequestException as exc:
        detail = ""
        if exc.response is not None:
            detail = f"\nServer response: {exc.response.text[:2000]}"
        raise RuntimeError(f"Inference request failed: {exc}{detail}") from exc
    except (ValueError, KeyError, IndexError, TypeError) as exc:
        raise RuntimeError("llama-server returned an unexpected response") from exc
    return response_text(content)


def validate_result(result: Any) -> dict[str, Any]:
    if not isinstance(result, dict):
        raise ValueError("root must be a JSON object")
    if not isinstance(result.get("title"), str) or not result["title"].strip():
        raise ValueError("title must be a non-empty string")
    components = result.get("components")
    if not isinstance(components, list):
        raise ValueError("components must be an array")
    for index, component in enumerate(components):
        prefix = f"components[{index}]"
        if not isinstance(component, dict):
            raise ValueError(f"{prefix} must be an object")
        for field in ("name", "query"):
            if not isinstance(component.get(field), str) or not component[field].strip():
                raise ValueError(f"{prefix}.{field} must be a non-empty string")
        weight = component.get("estimated_weight_grams")
        if isinstance(weight, bool) or not isinstance(weight, (int, float)) or weight < 0:
            raise ValueError(f"{prefix}.estimated_weight_grams must be a non-negative number")
        confidence = component.get("confidence")
        if isinstance(confidence, bool) or not isinstance(confidence, (int, float)) or not 0 <= confidence <= 1:
            raise ValueError(f"{prefix}.confidence must be between 0 and 1")
    return result


def decode_json(text: str) -> Any:
    """Decode JSON, including one common extra layer of JSON string encoding."""
    value = json.loads(text)
    if isinstance(value, str):
        value = json.loads(value)
    return value


def parse_result(raw: str) -> dict[str, Any]:
    """Find and validate the JSON object contained in the model's text response."""
    text = raw.strip()
    candidates = [text]

    lines = text.splitlines()
    if len(lines) >= 3 and lines[0].strip().lower() in {"```", "```json"} and lines[-1].strip() == "```":
        candidates.append("\n".join(lines[1:-1]).strip())

    errors: list[str] = []
    for candidate in candidates:
        try:
            return validate_result(decode_json(candidate))
        except (json.JSONDecodeError, ValueError) as exc:
            errors.append(str(exc))

    # If the model adds a short explanation around the object, raw_decode finds the
    # complete JSON value without brittle first-brace/last-brace slicing.
    decoder = json.JSONDecoder()
    for position, character in enumerate(text):
        if character != "{":
            continue
        try:
            value, _ = decoder.raw_decode(text[position:])
            return validate_result(value)
        except (json.JSONDecodeError, ValueError):
            continue

    preview = text[:240].replace("\n", "\\n")
    reason = errors[0] if errors else "no JSON object found"
    raise ValueError(f"model text did not contain valid meal JSON ({reason}); preview: {preview!r}")


def write_raw(raw: str, output: Path) -> Path:
    raw_path = output.with_suffix(".raw.txt")
    raw_path.parent.mkdir(parents=True, exist_ok=True)
    raw_path.write_text(raw + "\n", encoding="utf-8")
    return raw_path


def main() -> int:
    if sys.version_info < (3, 10):
        print("Python 3.10 or newer is required.", file=sys.stderr)
        return 2

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("image", type=Path, help="Input meal image (JPEG).")
    parser.add_argument("-o", "--output", type=Path, help="JSON output path (default: outputs/<image>.json).")
    parser.add_argument("--language", choices=("en", "de"), default="en")
    parser.add_argument("--hint", help="Optional information about the photographed meal.")
    parser.add_argument("--save-raw", action="store_true", help="Also save the model's raw text response.")
    parser.add_argument("--server-url", help="Use an already-running llama-server instead of starting one.")
    parser.add_argument("--max-tokens", type=int, default=1024)
    args = parser.parse_args()

    image = args.image.expanduser().resolve()
    if not image.is_file():
        print(f"Image not found: {image}", file=sys.stderr)
        return 2
    if args.max_tokens < 1:
        print("--max-tokens must be positive", file=sys.stderr)
        return 2

    output = args.output or (OUTPUTS_DIR / f"{image.stem}.json")
    output = output.expanduser().resolve()
    raw: str | None = None

    try:
        config = load_config()
        payload = request_payload(image, args.language, args.hint, args.max_tokens)
        timeout = float(config["server"]["request_timeout_seconds"])
        if args.server_url:
            raw = call_server(args.server_url, payload, timeout)
        else:
            print("Starting llama.cpp and loading the model ...", file=sys.stderr)
            with LocalLlamaServer(config) as local:
                raw = call_server(local.url, payload, timeout)

        if args.save_raw:
            raw_path = write_raw(raw, output)
            print(f"Raw response: {raw_path}", file=sys.stderr)

        try:
            result = parse_result(raw)
        except ValueError as exc:
            raw_path = write_raw(raw, output)
            raise ValueError(f"{exc}\nRaw model response saved to: {raw_path}") from exc

        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(json.dumps(result, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    except (OSError, RuntimeError, ValueError, TimeoutError) as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        print("Interrupted.", file=sys.stderr)
        return 130

    print(json.dumps(result, indent=2, ensure_ascii=False))
    print(f"Wrote: {output}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
