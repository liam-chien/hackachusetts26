#!/usr/bin/env python3
"""Download and verify the pinned llama.cpp runtime and Evora GGUF weights.

Run `python -m pip install -r requirements.txt` first, then `python setup.py`.
Downloaded artifacts stay beside this script under runtime/ and weights/; both are
ignored by Git.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import platform
import shutil
import stat
import sys
import tarfile
import tempfile
import time
import zipfile
from pathlib import Path
from typing import Any

try:
    import requests
except ImportError as exc:
    raise SystemExit(
        "Missing dependency 'requests'. Run:\n"
        "    python -m pip install -r requirements.txt"
    ) from exc

ROOT = Path(__file__).resolve().parent
CONFIG_PATH = ROOT / "artifacts.json"
WEIGHTS_DIR = ROOT / "weights"
RUNTIME_DIR = ROOT / "runtime"
DOWNLOAD_DIR = ROOT / ".downloads"


def load_config() -> dict[str, Any]:
    try:
        config = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise RuntimeError(f"Cannot read {CONFIG_PATH}: {exc}") from exc
    if config.get("schema_version") != 1:
        raise RuntimeError("Unsupported artifacts.json schema version")
    return config


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


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def is_valid(path: Path, artifact: dict[str, Any], *, announce: bool = False) -> bool:
    if not path.is_file():
        return False
    expected_size = artifact["size_bytes"]
    if path.stat().st_size != expected_size:
        if announce:
            print(f"INVALID {path.name}: wrong size")
        return False
    if announce:
        print(f"Checking {path.name} ...", end=" ", flush=True)
    valid = sha256(path) == artifact["sha256"]
    if announce:
        print("OK" if valid else "INVALID checksum")
    return valid


def _progress(done: int, total: int, started: float) -> None:
    percent = min(100.0, done * 100.0 / total) if total else 0.0
    elapsed = max(time.monotonic() - started, 0.001)
    rate = done / elapsed / (1024 * 1024)
    print(
        f"\r  {done / (1024 ** 2):,.1f} / {total / (1024 ** 2):,.1f} MiB "
        f"({percent:5.1f}%) at {rate:,.1f} MiB/s",
        end="",
        flush=True,
    )


def download(url: str, destination: Path, artifact: dict[str, Any], *, force: bool) -> None:
    """Stream and verify one artifact, resuming a partial download when possible."""
    destination.parent.mkdir(parents=True, exist_ok=True)
    if not force and is_valid(destination, artifact, announce=True):
        return

    partial = destination.with_name(destination.name + ".part")
    if force and partial.exists():
        partial.unlink()

    expected_size = artifact["size_bytes"]
    existing = partial.stat().st_size if partial.exists() else 0
    if existing > expected_size:
        partial.unlink()
        existing = 0
    if existing == expected_size:
        if is_valid(partial, artifact, announce=True):
            os.replace(partial, destination)
            return
        partial.unlink()
        existing = 0

    headers = {"User-Agent": "hackachusetts26-model-setup/1.0"}
    if existing:
        headers["Range"] = f"bytes={existing}-"
        print(f"Resuming {destination.name} at {existing / (1024 ** 2):,.1f} MiB")
    else:
        print(f"Downloading {destination.name}")

    try:
        with requests.get(url, headers=headers, stream=True, timeout=(30, 600)) as response:
            response.raise_for_status()
            append = existing > 0 and response.status_code == 206
            if not append:
                existing = 0
            mode = "ab" if append else "wb"
            done = existing
            started = time.monotonic()
            last_update = 0.0
            with partial.open(mode) as stream:
                for chunk in response.iter_content(chunk_size=1024 * 1024):
                    if not chunk:
                        continue
                    stream.write(chunk)
                    done += len(chunk)
                    now = time.monotonic()
                    if now - last_update >= 0.25:
                        _progress(done, expected_size, started)
                        last_update = now
            _progress(done, expected_size, started)
            print()
    except requests.RequestException as exc:
        raise RuntimeError(
            f"Download failed for {destination.name}: {exc}\n"
            f"Partial data was kept at {partial}; rerun setup to resume."
        ) from exc

    if not is_valid(partial, artifact, announce=True):
        partial.unlink(missing_ok=True)
        raise RuntimeError(f"Downloaded file failed verification: {destination.name}")
    os.replace(partial, destination)


def _safe_member(root: Path, name: str) -> Path:
    target = (root / name).resolve()
    try:
        target.relative_to(root.resolve())
    except ValueError as exc:
        raise RuntimeError(f"Unsafe path in runtime archive: {name}") from exc
    return target


def extract_archive(archive: Path, destination: Path) -> None:
    """Extract a checksum-verified zip or tar archive without path traversal."""
    if archive.name.endswith(".zip"):
        with zipfile.ZipFile(archive) as bundle:
            for member in bundle.infolist():
                _safe_member(destination, member.filename)
            bundle.extractall(destination)
        return

    with tarfile.open(archive, "r:gz") as bundle:
        for member in bundle.getmembers():
            member_path = _safe_member(destination, member.name)
            if member.issym():
                _safe_member(destination, str(member_path.parent.relative_to(destination) / member.linkname))
            elif member.islnk():
                _safe_member(destination, member.linkname)
        bundle.extractall(destination)


def runtime_install_dir(config: dict[str, Any], key: str) -> Path:
    return RUNTIME_DIR / f"llama-{config['llama_cpp']['release']}-{key}"


def runtime_binary(config: dict[str, Any], key: str) -> Path:
    platform_entry = config["llama_cpp"]["platforms"][key]
    return runtime_install_dir(config, key) / platform_entry["executable"]


def runtime_is_valid(config: dict[str, Any], key: str) -> bool:
    target = runtime_install_dir(config, key)
    marker = target / ".installed.json"
    binary = runtime_binary(config, key)
    if not marker.is_file() or not binary.is_file():
        return False
    try:
        installed = json.loads(marker.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return False
    expected = config["llama_cpp"]["platforms"][key]
    return (
        installed.get("release") == config["llama_cpp"]["release"]
        and installed.get("platform") == key
        and installed.get("archive_sha256") == expected["sha256"]
    )


def install_runtime(config: dict[str, Any], key: str, *, force: bool) -> Path:
    if not force and runtime_is_valid(config, key):
        binary = runtime_binary(config, key)
        print(f"Runtime OK: {binary}")
        return binary

    llama = config["llama_cpp"]
    artifact = llama["platforms"][key]
    archive = DOWNLOAD_DIR / artifact["archive"]
    url = f"{llama['download_base']}/{artifact['archive']}"
    download(url, archive, artifact, force=force)

    RUNTIME_DIR.mkdir(parents=True, exist_ok=True)
    target = runtime_install_dir(config, key)
    with tempfile.TemporaryDirectory(prefix="llama-extract-", dir=RUNTIME_DIR) as temp:
        extracted = Path(temp) / "extracted"
        extracted.mkdir()
        extract_archive(archive, extracted)
        matches = list(extracted.rglob(artifact["executable"]))
        if len(matches) != 1:
            raise RuntimeError(
                f"Expected one {artifact['executable']} in {archive.name}; found {len(matches)}"
            )
        source_root = matches[0].parent
        if target.exists():
            shutil.rmtree(target)
        shutil.move(str(source_root), str(target))

    binary = runtime_binary(config, key)
    if os.name != "nt":
        binary.chmod(binary.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
    marker = {
        "release": llama["release"],
        "platform": key,
        "archive_sha256": artifact["sha256"],
    }
    (target / ".installed.json").write_text(json.dumps(marker, indent=2) + "\n", encoding="utf-8")
    archive.unlink(missing_ok=True)
    print(f"Installed runtime: {binary}")
    return binary


def model_url(config: dict[str, Any], filename: str) -> str:
    model = config["model"]
    return (
        f"https://huggingface.co/{model['repository']}/resolve/"
        f"{model['revision']}/{filename}?download=true"
    )


def install_weights(config: dict[str, Any], *, force: bool) -> None:
    WEIGHTS_DIR.mkdir(parents=True, exist_ok=True)
    for artifact in config["model"]["files"].values():
        destination = WEIGHTS_DIR / artifact["filename"]
        download(model_url(config, artifact["filename"]), destination, artifact, force=force)


def check(config: dict[str, Any], key: str, *, runtime: bool, weights: bool) -> bool:
    valid = True
    if runtime:
        ok = runtime_is_valid(config, key)
        print(f"{'OK' if ok else 'MISSING/INVALID'} runtime ({key})")
        valid &= ok
    if weights:
        for artifact in config["model"]["files"].values():
            path = WEIGHTS_DIR / artifact["filename"]
            ok = is_valid(path, artifact, announce=path.exists())
            if not path.exists():
                print(f"MISSING {path.name}")
            valid &= ok
    return valid


def main() -> int:
    if sys.version_info < (3, 10):
        print("Python 3.10 or newer is required.", file=sys.stderr)
        return 2

    parser = argparse.ArgumentParser(description=__doc__)
    selection = parser.add_mutually_exclusive_group()
    selection.add_argument("--runtime-only", action="store_true", help="Only install llama.cpp.")
    selection.add_argument("--weights-only", action="store_true", help="Only install model weights.")
    parser.add_argument("--force", action="store_true", help="Download and install again.")
    parser.add_argument("--check", action="store_true", help="Verify installed files without downloading.")
    args = parser.parse_args()

    config = load_config()
    key = platform_key()
    platforms = config["llama_cpp"]["platforms"]
    if key not in platforms:
        supported = ", ".join(sorted(platforms))
        print(
            f"No pinned runtime for {key}. Supported: {supported}.\n"
            "You may use your own compatible binary by setting LLAMA_SERVER_PATH.",
            file=sys.stderr,
        )
        return 2

    want_runtime = not args.weights_only
    want_weights = not args.runtime_only
    print(f"Platform: {key}")

    if args.check:
        return 0 if check(config, key, runtime=want_runtime, weights=want_weights) else 1

    try:
        if want_runtime:
            install_runtime(config, key, force=args.force)
        if want_weights:
            install_weights(config, force=args.force)
    except (OSError, RuntimeError, zipfile.BadZipFile, tarfile.TarError) as exc:
        print(f"Setup failed: {exc}", file=sys.stderr)
        return 1

    print("Setup complete.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
