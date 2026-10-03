#!/usr/bin/env sh
# Builds native/mac-input into build/mac-input/Ciao.Input, one binary for Apple Silicon and Intel.
# Needs Xcode's command line tools (swiftc, lipo), so it runs on macOS only.
set -e
cd "$(dirname "$0")/.."
out=build/mac-input
mkdir -p "$out"
for arch in arm64 x86_64; do
  swiftc -O -swift-version 5 -target "$arch-apple-macos13" native/mac-input/main.swift -o "$out/Ciao.Input-$arch"
done
lipo -create "$out/Ciao.Input-arm64" "$out/Ciao.Input-x86_64" -output "$out/Ciao.Input"
rm "$out/Ciao.Input-arm64" "$out/Ciao.Input-x86_64"
