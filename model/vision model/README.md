# Vision food-recognition model

This component runs the open-weight [Evora Qwen3-VL food-recognition model](https://huggingface.co/mkenfenheuer/evora-qwen3-vl-2b-photos-v3-GGUF) locally. Given a meal image, it returns a JSON title and a list of food components with estimated gram weights and confidence scores.

The repository does **not** contain model weights or native binaries. `setup.py` downloads immutable, checksum-verified artifacts when the project is set up.

## Architecture

- Python handles setup, image input, process lifecycle, HTTP communication, validation, and JSON output.
- The official [llama.cpp `b11200` release](https://github.com/ggml-org/llama.cpp/releases/tag/b11200) performs inference through `llama-server`. This is the build documented by the model author.
- `artifacts.json` pins the llama.cpp release, six platform archives, the Hugging Face repository revision, filenames, sizes, and SHA-256 checksums.
- No `llama-cpp-python` fork or local C/C++ compiler is required.

## Supported baseline platforms

| Operating system | ARM64 | x86-64 | Default backend |
| --- | --- | --- | --- |
| macOS | Yes | Yes | Official build (Metal is available on Apple Silicon) |
| Linux | Yes | Yes | Official Ubuntu CPU build |
| Windows | Yes | Yes | Official CPU build |

The default artifacts prioritize portability. For CUDA, Vulkan, ROCm, or a Linux distribution incompatible with the official Ubuntu binary, install a compatible `llama-server` yourself and set `LLAMA_SERVER_PATH` to it. The Python code does not change.

## Requirements

- Python 3.10 or newer
- Internet access during initial setup
- About 3 GB of disk space for the Q8 model, projector, and runtime
- Enough memory to run the Q8 model; approximately 8 GB of system memory is recommended

## Install

From this directory (`model/vision model`):

### macOS or Linux

```bash
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements.txt
python setup.py
```

### Windows PowerShell

```powershell
py -3.10 -m venv .venv
.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
python setup.py
```

`setup.py` downloads the correct llama.cpp build for the current OS/CPU plus both required files:

- `evora-qwen3-vl-2b-photos-v3.Q8_0.gguf`
- `mmproj-evora-qwen3-vl-2b-photos-v3.f16.gguf`

Downloads are resumable and are accepted only when both their size and SHA-256 match `artifacts.json`.

Useful setup commands:

```bash
python setup.py --check         # verify everything without downloading
python setup.py --runtime-only  # install only llama.cpp
python setup.py --weights-only  # install only the two GGUF files
python setup.py --force         # download and install everything again
```

## Recognize a meal

The input must be a JPEG. Before inference, the program applies the photo's EXIF rotation, reduces it to fit within 640×640 pixels without stretching or upscaling, and re-encodes it as a compact JPEG. This matches the image size used to train the model and prevents high-resolution photos from filling the model's context window.

```bash
python recognize_food.py path/to/meal.jpg
```

The model's response arrives as text containing JSON. The program extracts that JSON, validates its fields, and writes `outputs/<image-name>.json`; it also prints the parsed object to stdout. It accepts plain JSON text as well as common wrappers such as a `json` Markdown fence or one extra JSON-string encoding layer. To select the output path:

```bash
python recognize_food.py meal.jpg --output outputs/lunch.json
```

Optional arguments:

```bash
python recognize_food.py meal.jpg --hint "cafeteria lunch"
python recognize_food.py meal.jpg --language de
python recognize_food.py meal.jpg --save-raw
```

`--save-raw` preserves the model's original text as `<output-name>.raw.txt` before it is parsed and validated. The normal output remains JSON. If parsing fails, the raw text is saved automatically so the exact response can be inspected.

Example output shape:

```json
{
  "title": "Example meal",
  "components": [
    {
      "name": "Example food",
      "query": "example food cooked",
      "estimated_weight_grams": 120,
      "confidence": 0.91
    }
  ]
}
```

The program rejects malformed JSON or objects missing the expected fields instead of silently writing unusable output.

## Use an existing server or custom backend

Point to another compatible llama.cpp binary while retaining automatic lifecycle management:

```bash
export LLAMA_SERVER_PATH=/path/to/llama-server       # macOS/Linux
$env:LLAMA_SERVER_PATH='C:\path\to\llama-server.exe' # Windows PowerShell
python recognize_food.py meal.jpg
```

Or connect to a server that you started separately:

```bash
python recognize_food.py meal.jpg --server-url http://127.0.0.1:8080
```

Only bind llama-server to localhost unless authentication and network controls are added.

## Generated files and Git

These paths are intentionally ignored by Git:

- `weights/` — downloaded GGUF files
- `runtime/` — extracted llama.cpp binary and shared libraries
- `.downloads/` — resumable temporary downloads
- `outputs/` — generated JSON, raw output, and server logs

Commit source files and `artifacts.json`, not generated artifacts.

## Updating pinned artifacts

Do not change a URL alone. When upgrading llama.cpp or the model, update the release/revision, expected size, and SHA-256 in `artifacts.json`, then run `python setup.py --force` and perform an image smoke test on every supported platform family.

## Accuracy and licensing

Single-image portion weights are estimates. Hidden ingredients, sauces, and oils may be undercounted, and this is not intended for clinical nutrition decisions. The model is Apache-2.0; llama.cpp is MIT licensed. See the linked upstream pages for complete terms and attribution.

Content was rephrased for compliance with licensing restrictions.
