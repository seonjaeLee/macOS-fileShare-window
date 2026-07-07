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
# "정상 작동이 검증된 Electron.app"을 그대로 복사한 뒤
# 우리 앱 코드/아이콘/이름만 얹어서 .app을 조립한다.
# 내부 실행 파일과 헬퍼 이름은 원본("Electron") 그대로 두어(껍데기만 한글 이름) 안정성을 유지한다.
#
# 사용법:
#   ./build-app.sh            # Apple Silicon(arm64)용만 빌드 (기본, 빠름)
#   ./build-app.sh arm64 x64  # Apple Silicon + 인텔(x64)용 둘 다 빌드
#     (x64는 별도로 electron x64 배포본을 내려받으므로 처음 실행 시 시간이 더 걸림)
#
# 결과물:
#   dist/한글 파일명 정리.app            (arm64)
#   dist/한글 파일명 정리 (Intel용).app   (x64, 요청 시)

set -euo pipefail
cd "$(dirname "$0")"

APP_NAME="한글 파일명 정리"
BUNDLE_ID="kr.seonjae.hangul-filename-fixer"
VERSION="1.0.0"
OUT_DIR="dist"
ARCHES=("${@:-arm64}")

echo "==> 0) 사전 점검"
if [ ! -f "build/icon.icns" ]; then
  echo "오류: build/icon.icns 가 없습니다." >&2
  exit 1
fi
if [ ! -d "node_modules/electron" ]; then
  echo "오류: node_modules/electron 가 없습니다. 먼저 'npm install'을 실행하세요." >&2
  exit 1
fi

ELECTRON_VERSION="$(node -p "require('./node_modules/electron/package.json').version")"

# 스테이징(앱 코드 + 런타임 의존성)은 arch와 무관하게 동일하므로 한 번만 만들어 재사용한다.
echo "==> 1) 런타임 의존성만 담은 앱 코드 스테이징 (archiver만, electron/electron-builder 제외)"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
cp main.js preload.js renderer.js index.html style.css package.json "$STAGE/"
(
  cd "$STAGE"
  npm install --omit=dev --no-audit --no-fund --silent
  # 혹시 섞여 들어온 개발용 잔여 패키지 제거
  npm prune --omit=dev --silent 2>/dev/null || true
)

mkdir -p "$OUT_DIR"

build_one() {
  local arch="$1" src_electron="$2" app_name="$3"
  local app="$OUT_DIR/$app_name.app"

  echo "==> [$arch] 이전 빌드 정리"
  chmod -R u+w "$app" 2>/dev/null || true
  rm -rf "$app"

  echo "==> [$arch] 검증된 Electron.app 복사 ($src_electron)"
  cp -R "$src_electron" "$app"

  echo "==> [$arch] 앱 코드를 Contents/Resources/app/ 에 배치"
  local appcode="$app/Contents/Resources/app"
  mkdir -p "$appcode"
  cp "$STAGE"/main.js "$STAGE"/preload.js "$STAGE"/renderer.js "$STAGE"/index.html "$STAGE"/style.css "$STAGE"/package.json "$appcode/"
  cp -R "$STAGE/node_modules" "$appcode/node_modules"

  echo "==> [$arch] 아이콘 배치"
  cp build/icon.icns "$app/Contents/Resources/icon.icns"

  echo "==> [$arch] Info.plist 수정 (표시 이름 / 식별자 / 아이콘)"
  local plist="$app/Contents/Info.plist"
  plutil -replace CFBundleName -string "$app_name" "$plist"
  plutil -replace CFBundleDisplayName -string "$app_name" "$plist"
  plutil -replace CFBundleIdentifier -string "$BUNDLE_ID" "$plist"
  plutil -replace CFBundleIconFile -string "icon.icns" "$plist"
  plutil -replace CFBundleShortVersionString -string "$VERSION" "$plist"
  plutil -replace CFBundleVersion -string "$VERSION" "$plist"

  echo "==> [$arch] ad-hoc 재서명"
  codesign --force --deep --sign - "$app" >/dev/null 2>&1
  codesign --verify --deep --strict "$app" && echo "    서명 검증 통과"

  echo "완료: $app"
}

for arch in "${ARCHES[@]}"; do
  case "$arch" in
    arm64)
      build_one "arm64" "node_modules/electron/dist/Electron.app" "$APP_NAME"
      ;;
    x64)
      echo "==> [x64] electron x64 배포본 내려받는 중 (최초 1회만, 시간이 걸릴 수 있음)"
      # electron 패키지는 npm postinstall이 아니라 require('electron') 시점에 지연 다운로드하므로
      # (node_modules/electron/index.js 참고), install.js를 ELECTRON_INSTALL_ARCH=x64로 직접 실행해야 함.
      X64_STAGE="$(mktemp -d)"
      (
        cd "$X64_STAGE"
        npm init -y >/dev/null 2>&1
        npm install "electron@$ELECTRON_VERSION" --no-save --no-audit --no-fund --silent --ignore-scripts
        ELECTRON_INSTALL_ARCH=x64 node node_modules/electron/install.js
      )
      build_one "x64" "$X64_STAGE/node_modules/electron/dist/Electron.app" "$APP_NAME (Intel용)"
      rm -rf "$X64_STAGE"
      ;;
    *)
      echo "알 수 없는 arch: $arch (arm64 또는 x64만 지원)" >&2
      exit 1
      ;;
  esac
done

echo ""
echo "모두 완료. 실행: open \"$OUT_DIR/<앱 이름>.app\" 또는 Finder에서 더블클릭"
