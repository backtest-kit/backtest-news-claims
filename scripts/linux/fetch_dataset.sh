#!/usr/bin/env bash
# Downloads investinglive.jsonl from Hugging Face as ./assets/wwwroot.jsonl
#
# Usage:
#   ./scripts/linux/fetch_dataset.sh
#
# Environment:
#   FORCE=1     re-download even if assets/wwwroot.jsonl already exists
#
# Requires: curl or wget

set -euo pipefail

URL="https://huggingface.co/datasets/tripolskypetr/investinglive-crypto/resolve/main/investinglive.jsonl"

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ASSETS_DIR="$ROOT_DIR/assets"
OUT_PATH="$ASSETS_DIR/wwwroot.jsonl"
PART_PATH="$OUT_PATH.part"

mkdir -p "$ASSETS_DIR"

if [[ -s "$OUT_PATH" && -z "${FORCE:-}" ]]; then
  echo "$OUT_PATH already exists, skipping. Set FORCE=1 to re-download."
  exit 0
fi

cleanup() { rm -f "$PART_PATH"; }
trap cleanup EXIT

echo "Downloading $URL"
if command -v curl >/dev/null 2>&1; then
  curl -fL --retry 3 --retry-delay 2 --progress-bar -o "$PART_PATH" "$URL"
elif command -v wget >/dev/null 2>&1; then
  wget -O "$PART_PATH" "$URL"
else
  echo "Error: neither curl nor wget is installed." >&2
  exit 1
fi

if [[ ! -s "$PART_PATH" ]]; then
  echo "Error: downloaded file is empty." >&2
  exit 1
fi

mv -f "$PART_PATH" "$OUT_PATH"

echo "Done: $OUT_PATH ($(du -h "$OUT_PATH" | cut -f1))"
