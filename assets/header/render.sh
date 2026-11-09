#!/usr/bin/env sh
# Render the README header PNGs (1774x887, the house size) from template.html
# with headless Chrome. Fonts are fetched into fonts/ on first run (Poppins,
# OFL). Usage: assets/header/render.sh
set -eu
here="$(cd "$(dirname "$0")" && pwd)"
out="$(cd "$here/.." && pwd)"
chrome="${CHROME:-$(command -v google-chrome || command -v chromium || command -v chromium-browser)}"
mkdir -p "$here/fonts"
for f in poppins/Poppins-Black poppins/Poppins-SemiBold; do
  name="$(basename "$f")"
  [ -f "$here/fonts/$name.ttf" ] || curl -fsSL -o "$here/fonts/$name.ttf" "https://github.com/google/fonts/raw/main/ofl/$f.ttf"
done
for mode in dark light; do
  sed "s/class=\"MODE\"/class=\"$mode\"/" "$here/template.html" > "$here/.render-$mode.html"
  # A fresh profile per run: a profile still locked by an earlier Chrome hangs the next one.
  profile="$(mktemp -d)"
  "$chrome" --headless=new --no-sandbox --disable-gpu --hide-scrollbars --force-device-scale-factor=1 \
    --user-data-dir="$profile" --window-size=1774,887 --screenshot="$out/signing-guard-readme-header-$mode.png" "file://$here/.render-$mode.html" 2>/dev/null
  rm -rf "$here/.render-$mode.html" "$profile"
  echo "wrote $out/signing-guard-readme-header-$mode.png"
done
