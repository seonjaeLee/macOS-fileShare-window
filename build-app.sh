#!/bin/bash
#
# 로컬 전용 macOS .app 빌드 스크립트
#
# 배경: macOS 26 + Apple Silicon 환경에서 electron-builder가 만든 .app은 시작하자마자
# V8 JIT 초기화 단계에서 SIGTRAP(EXC_BREAKPOINT)로 죽는 문제가 있음
# (Electron 자체의 알려진 이슈: https://github.com/electron/electron/issues/51351).
# 반면 npm이 내려받은 node_modules/electron/dist/Electron.app 원본은 정상 실행됨.
#
# 그래서 이 스크립트는 electron-builder를 쓰지 않고,
# "정상 작동이 검증된 node_modules의 Electron.app"을 그대로 복사한 뒤
# 우리 앱 코드/아이콘/이름만 얹어서 .app을 조립한다.
# 내부 실행 파일과 헬퍼 이름은 원본("Electron") 그대로 두어(껍데기만 한글 이름) 안정성을 유지한다.
#
# 사용법: ./build-app.sh
# 결과물: dist/한글 파일명 정리.app

set -euo pipefail
cd "$(dirname "$0")"

APP_NAME="한글 파일명 정리"
BUNDLE_ID="kr.seonjae.hangul-filename-fixer"
VERSION="1.0.0"
SRC_ELECTRON="node_modules/electron/dist/Electron.app"
OUT_DIR="dist"
APP="$OUT_DIR/$APP_NAME.app"

echo "==> 0) 사전 점검"
if [ ! -d "$SRC_ELECTRON" ]; then
  echo "오류: $SRC_ELECTRON 가 없습니다. 먼저 'npm install'을 실행하세요." >&2
  exit 1
fi
if [ ! -f "build/icon.icns" ]; then
  echo "오류: build/icon.icns 가 없습니다." >&2
  exit 1
fi

echo "==> 1) 이전 빌드 정리"
chmod -R u+w "$APP" 2>/dev/null || true
rm -rf "$APP"
mkdir -p "$OUT_DIR"

echo "==> 2) 검증된 Electron.app 복사"
cp -R "$SRC_ELECTRON" "$APP"

echo "==> 3) 런타임 의존성만 담은 앱 코드 스테이징 (archiver만, electron/electron-builder 제외)"
STAGE="$(mktemp -d)"
cp main.js preload.js renderer.js index.html style.css package.json "$STAGE/"
(
  cd "$STAGE"
  npm install --omit=dev --no-audit --no-fund --silent
  # 혹시 섞여 들어온 개발용 잔여 패키지 제거
  npm prune --omit=dev --silent 2>/dev/null || true
)

echo "==> 4) 앱 코드를 Contents/Resources/app/ 에 배치"
APPCODE="$APP/Contents/Resources/app"
mkdir -p "$APPCODE"
cp "$STAGE"/main.js "$STAGE"/preload.js "$STAGE"/renderer.js "$STAGE"/index.html "$STAGE"/style.css "$STAGE"/package.json "$APPCODE/"
cp -R "$STAGE/node_modules" "$APPCODE/node_modules"
rm -rf "$STAGE"

echo "==> 5) 아이콘 배치"
cp build/icon.icns "$APP/Contents/Resources/icon.icns"

echo "==> 6) Info.plist 수정 (표시 이름 / 식별자 / 아이콘)"
PLIST="$APP/Contents/Info.plist"
plutil -replace CFBundleName -string "$APP_NAME" "$PLIST"
plutil -replace CFBundleDisplayName -string "$APP_NAME" "$PLIST"
plutil -replace CFBundleIdentifier -string "$BUNDLE_ID" "$PLIST"
plutil -replace CFBundleIconFile -string "icon.icns" "$PLIST"
plutil -replace CFBundleShortVersionString -string "$VERSION" "$PLIST"
plutil -replace CFBundleVersion -string "$VERSION" "$PLIST"

echo "==> 7) ad-hoc 재서명"
codesign --force --deep --sign - "$APP" >/dev/null 2>&1
codesign --verify --deep --strict "$APP" && echo "    서명 검증 통과"

echo ""
echo "완료: $APP"
echo "실행: open \"$APP\"  또는 Finder에서 더블클릭"
