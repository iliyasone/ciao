#!/usr/bin/env sh
# Renders assets/icon.svg into every icon the app and the site use. Needs rsvg-convert and ImageMagick.
set -e
cd "$(dirname "$0")/.."
rsvg-convert -w 512 assets/icon.svg -o assets/icon.png
rsvg-convert -w 32 assets/icon.svg -o assets/tray.png
dir=$(mktemp -d)
for s in 16 24 32 48 64 128 256; do rsvg-convert -w $s assets/icon.svg -o "$dir/$s.png"; done
convert "$dir"/16.png "$dir"/24.png "$dir"/32.png "$dir"/48.png "$dir"/64.png "$dir"/128.png "$dir"/256.png assets/icon.ico
rm -r "$dir"
cp assets/icon.png src/renderer/public/icon.png
cp assets/icon.png site/icon.png
