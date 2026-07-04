#!/bin/bash
#
# build/icon.svg 로부터 macOS .icns 아이콘을 생성한다.
# icon.icns는 build-app.sh가 사용하며 저장소에 커밋되어 있으므로,
# 아이콘 디자인(icon.svg)을 바꿨을 때만 이 스크립트를 다시 실행하면 된다.
#
# 필요 도구: rsvg-convert (brew install librsvg), iconutil(macOS 기본 제공)
# 사용법: ./build-icon.sh

set -euo pipefail
cd "$(dirname "$0")"

if ! command -v rsvg-convert >/dev/null 2>&1; then
  echo "오류: rsvg-convert 가 없습니다. 'brew install librsvg' 로 설치하세요." >&2
  exit 1
fi

SVG="build/icon.svg"
ICONSET="build/AppIcon.iconset"

rm -rf "$ICONSET"
mkdir -p "$ICONSET"

# macOS가 요구하는 크기 세트 (@2x 포함)
declare -a sizes=(
  "16:icon_16x16.png"
  "32:icon_16x16@2x.png"
  "32:icon_32x32.png"
  "64:icon_32x32@2x.png"
  "128:icon_128x128.png"
  "256:icon_128x128@2x.png"
  "256:icon_256x256.png"
  "512:icon_256x256@2x.png"
  "512:icon_512x512.png"
  "1024:icon_512x512@2x.png"
)

for entry in "${sizes[@]}"; do
  size="${entry%%:*}"
  name="${entry##*:}"
  rsvg-convert -w "$size" -h "$size" "$SVG" -o "$ICONSET/$name"
done

iconutil -c icns "$ICONSET" -o build/icon.icns
echo "생성 완료: build/icon.icns"
