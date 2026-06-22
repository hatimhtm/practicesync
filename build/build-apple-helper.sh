#!/bin/bash
# Build the on-device Apple Intelligence helper (macOS 26+, Apple Silicon).
# Produces build/bin/apple-intelligence. Safe to run on any Mac with Xcode 26;
# on machines without it the app simply doesn't offer the Apple Intelligence
# engine and uses local Gemma / the built-in parser instead.
set -euo pipefail
cd "$(dirname "$0")"

# Always create the output dir so the packaging step's extraResources path
# exists even when the helper can't be built (the app then falls back to
# Gemma / the built-in matcher).
mkdir -p bin

# Xcode (not just Command Line Tools) is required for the macOS 26 SDK.
DEVDIR="${DEVELOPER_DIR:-/Applications/Xcode.app/Contents/Developer}"
if [ ! -d "$DEVDIR" ]; then
  echo "Xcode not found at $DEVDIR — skipping Apple Intelligence helper (Gemma/built-in still work)." >&2
  exit 0
fi
# Don't fail a release if this runner lacks the macOS 26 SDK — the app falls back
# to local Gemma / the built-in parser when the helper is absent. So a compile
# failure is a warning, not a hard error.
if DEVELOPER_DIR="$DEVDIR" xcrun -sdk macosx swiftc \
  -target arm64-apple-macos26.0 \
  -O \
  -parse-as-library \
  -framework FoundationModels \
  apple-intelligence.swift \
  -o bin/apple-intelligence; then
  echo "Built build/bin/apple-intelligence ✓"
else
  echo "WARNING: could not build the Apple Intelligence helper (needs Xcode 26 / macOS 26 SDK). The app will use local Gemma / built-in parsing instead." >&2
fi
