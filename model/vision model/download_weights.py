#!/usr/bin/env python3
"""Download the Evora vision model weights into ./weights/.

Usage (from the "model/vision model" folder):
    python download_weights.py

Safe to re-run: files that are already complete are skipped, and partial
downloads resume where they stopped. Each file's SHA-256 is checked before
it is accepted.
"""
import hashlib
import os
import ssl
import sys
import urllib.request
from pathlib import Path

# Some Python installs (e.g. python.org on macOS) ship without CA certificates.
# Use certifi's bundle when it is installed (it is, via requirements.txt).
try:
    import certifi

    SSL_CONTEXT = ssl.create_default_context(cafile=certifi.where())
except ImportError:
    SSL_CONTEXT = None

# Pinned Hugging Face revision, so every machine gets the exact same files.
REPO = "mkenfenheuer/evora-qwen3-vl-2b-photos-v3-GGUF"
REVISION = "b3ef4d19340b01d41dad2781a6bb78ef5bc6b17a"
BASE_URL = f"https://huggingface.co/{REPO}/resolve/{REVISION}"

# filename -> (size in bytes, sha256), taken from the model card
FILES = {
    "evora-qwen3-vl-2b-photos-v3.Q8_0.gguf": (
        1834427360,
        "deb6514fccd6e0a52af6be6cad605e10e27fd4c8bb14594966d7829fe89247f1",
    ),
    "mmproj-evora-qwen3-vl-2b-photos-v3.f16.gguf": (
        819394784,
        "f4fcaaad0593143fb20cf8d1afe7529a21f5ba3d0f1c900828fc16b34c787a40",
    ),
}

WEIGHTS_DIR = Path(__file__).resolve().parent / "weights"
CHUNK = 1024 * 1024  # 1 MiB


def sha256_of(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for block in iter(lambda: f.read(CHUNK), b""):
            h.update(block)
    return h.hexdigest()


def download(name: str, size: int, sha: str) -> None:
    dest = WEIGHTS_DIR / name
    part = dest.with_name(name + ".part")

    # Already downloaded and correct: skip.
    if dest.exists() and dest.stat().st_size == size and sha256_of(dest) == sha:
        print(f"OK (already present): {name}")
        return

    # Resume a partial download if one exists.
    start = part.stat().st_size if part.exists() else 0
    if start > size:
        part.unlink()
        start = 0

    if start < size:
        request = urllib.request.Request(f"{BASE_URL}/{name}")
        if start:
            request.add_header("Range", f"bytes={start}-")
            print(f"Resuming {name} at {start / 2**20:.0f} MiB")
        else:
            print(f"Downloading {name}")

        with urllib.request.urlopen(request, timeout=60, context=SSL_CONTEXT) as response:
            # 206 = server honoured the Range request; otherwise start over.
            mode = "ab" if response.status == 206 else "wb"
            done = start if mode == "ab" else 0
            with part.open(mode) as out:
                while chunk := response.read(CHUNK):
                    out.write(chunk)
                    done += len(chunk)
                    print(f"\r  {done / 2**20:,.0f} / {size / 2**20:,.0f} MiB", end="", flush=True)
        print()

    print(f"Verifying {name} ...")
    if part.stat().st_size != size or sha256_of(part) != sha:
        part.unlink()
        sys.exit(f"Checksum failed for {name}. The bad file was deleted; run again to retry.")
    os.replace(part, dest)
    print(f"OK: {name}")


def main() -> None:
    WEIGHTS_DIR.mkdir(parents=True, exist_ok=True)
    for name, (size, sha) in FILES.items():
        download(name, size, sha)
    print(f"\nAll weights ready in {WEIGHTS_DIR}")


if __name__ == "__main__":
    main()
