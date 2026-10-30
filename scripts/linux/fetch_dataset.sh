#!/usr/bin/env bash
# Downloads wwwroot.zip from Hugging Face and extracts wwwroot.jsonl into ./assets
#
# Usage:
#   ./scripts/linux/fetch_dataset.sh
#
# Environment:
#   FORCE=1     re-download even if assets/wwwroot.jsonl already exists
#   KEEP_ZIP=1  keep assets/wwwroot.zip after extraction (deleted by default)
#
# Requires: curl or wget, plus one of: unzip, 7z/7zz/7za, bsdtar, python3

set -euo pipefail

URL="https://huggingface.co/datasets/tripolskypetr/market-forecasting-dataset/resolve/main/assets/wwwroot.zip"
PASSWORD="123"
ENTRY="wwwroot.jsonl"

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ASSETS_DIR="$ROOT_DIR/assets"
ZIP_PATH="$ASSETS_DIR/wwwroot.zip"
PART_PATH="$ZIP_PATH.part"
OUT_PATH="$ASSETS_DIR/$ENTRY"

mkdir -p "$ASSETS_DIR"

if [[ -s "$OUT_PATH" && -z "${FORCE:-}" ]]; then
  echo "$OUT_PATH already exists, skipping. Set FORCE=1 to re-download."
  exit 0
fi

cleanup() { rm -f "$PART_PATH"; }
trap cleanup EXIT

# --- download -----------------------------------------------------------------

if [[ -s "$ZIP_PATH" && -z "${FORCE:-}" ]]; then
  echo "Using existing $ZIP_PATH"
else
  echo "Downloading $URL"
  if command -v curl >/dev/null 2>&1; then
    curl -fL --retry 3 --retry-delay 2 --progress-bar -o "$PART_PATH" "$URL"
  elif command -v wget >/dev/null 2>&1; then
    wget -O "$PART_PATH" "$URL"
  else
    echo "Error: neither curl nor wget is installed." >&2
    exit 1
  fi
  mv -f "$PART_PATH" "$ZIP_PATH"
fi

# --- extract ------------------------------------------------------------------

rm -f "$OUT_PATH"

if command -v unzip >/dev/null 2>&1; then
  echo "Extracting $ENTRY with unzip"
  unzip -o -P "$PASSWORD" "$ZIP_PATH" "$ENTRY" -d "$ASSETS_DIR"
elif command -v 7z >/dev/null 2>&1 || command -v 7zz >/dev/null 2>&1 || command -v 7za >/dev/null 2>&1; then
  SEVENZIP="$(command -v 7z || command -v 7zz || command -v 7za)"
  echo "Extracting $ENTRY with $SEVENZIP"
  "$SEVENZIP" x -y -p"$PASSWORD" -o"$ASSETS_DIR" "$ZIP_PATH" "$ENTRY"
elif command -v bsdtar >/dev/null 2>&1; then
  echo "Extracting $ENTRY with bsdtar"
  bsdtar --passphrase "$PASSWORD" -xf "$ZIP_PATH" -C "$ASSETS_DIR" "$ENTRY"
elif command -v python3 >/dev/null 2>&1; then
  echo "Extracting $ENTRY with python3 (slow, pure-Python decryption)"
  python3 -I -c 'import sys, zipfile; zipfile.ZipFile(sys.argv[1]).extract(sys.argv[2], sys.argv[3], pwd=sys.argv[4].encode())' \
    "$ZIP_PATH" "$ENTRY" "$ASSETS_DIR" "$PASSWORD"
else
  echo "Error: no supported extractor found. Install unzip (or 7z, bsdtar, python3) and run again." >&2
  echo "The downloaded archive was kept at $ZIP_PATH" >&2
  exit 1
fi

if [[ ! -s "$OUT_PATH" ]]; then
  echo "Error: $ENTRY was not extracted (wrong password or corrupted archive?)." >&2
  echo "The downloaded archive was kept at $ZIP_PATH" >&2
  exit 1
fi

if [[ -z "${KEEP_ZIP:-}" ]]; then
  rm -f "$ZIP_PATH"
fi

echo "Done: $OUT_PATH ($(du -h "$OUT_PATH" | cut -f1))"
