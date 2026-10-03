#!/usr/bin/env sh
# Renders assets/icon.svg into every icon the app and the site use. Needs rsvg-convert and ImageMagick.
set -e
# ImageMagick 7 is "magick"; on Windows a bare "convert" is the system disk tool.
magick=$(command -v magick || command -v convert || true)
case "$magick" in
  "" | */[Ss]ystem32/*) echo "build-icons: ImageMagick is required" >&2; exit 1 ;;
esac
cd "$(dirname "$0")/.."
rsvg-convert -w 512 assets/icon.svg -o assets/icon.png
rsvg-convert -w 32 assets/icon.svg -o assets/tray.png
dir=$(mktemp -d)
for s in 16 24 32 48 64 128 256; do rsvg-convert -w $s assets/icon.svg -o "$dir/$s.png"; done
"$magick" "$dir"/16.png "$dir"/24.png "$dir"/32.png "$dir"/48.png "$dir"/64.png "$dir"/128.png "$dir"/256.png assets/icon.ico
rm -r "$dir"
cp assets/icon.png src/renderer/public/icon.png
cp assets/icon.png site/icon.png
