#!/bin/bash
#
# dist/ 안의 .app(들)을 각각 설치용 .dmg로 감싼다.
# (macOS에서 흔히 보는 "아이콘을 응용 프로그램 폴더로 드래그" 설치 화면)
#
# 반드시 build-app.sh를 먼저 실행해 dist/*.app 이 만들어진 뒤에 실행할 것.
#
# 사용법: ./build-dmg.sh
# 결과물: dist/<앱 이름>.dmg (dist/ 안의 .app 개수만큼)

set -euo pipefail
cd "$(dirname "$0")"

OUT_DIR="dist"
ASCII_BASE="$(basename "$(pwd)")"

shopt -s nullglob
APPS=("$OUT_DIR"/*.app)
shopt -u nullglob

if [ ${#APPS[@]} -eq 0 ]; then
  echo "오류: $OUT_DIR/*.app 이 없습니다. 먼저 './build-app.sh'를 실행하세요." >&2
  exit 1
fi

make_dmg() {
  local app_path="$1"
  local app_base
  app_base="$(basename "$app_path" .app)"
  local volname="$app_base"
  # GitHub Release 첨부파일은 비ASCII(한글) 파일명을 지원하지 않아 업로드 시 이름이
  # 깨지므로(예: "default.dmg"), 배포용 .dmg 파일명은 영문(ASCII)으로 만든다.
  # 단, 마운트했을 때 Finder에 보이는 볼륨 이름(volname)은 한글 그대로 유지해 사용성은 지킨다.
  local asset_name="$ASCII_BASE"
  if [[ "$app_base" == *"Intel"* ]]; then
    asset_name="${ASCII_BASE}-intel"
  fi
  local final_dmg="$OUT_DIR/$asset_name.dmg"
  local staging
  staging="$(mktemp -d)"

  echo "==> [$app_base] DMG 스테이징 준비"
  cp -R "$app_path" "$staging/"
  ln -s /Applications "$staging/Applications"

  rm -f "$final_dmg"
  local rw_dmg
  rw_dmg="$(mktemp -u).dmg"

  echo "==> [$app_base] 임시(쓰기 가능) DMG 생성"
  hdiutil create -volname "$volname" -srcfolder "$staging" -fs HFS+ -format UDRW -ov "$rw_dmg" >/dev/null

  echo "==> [$app_base] Finder 아이콘 배치(설치 화면 꾸미기)"
  local mount_point="/Volumes/$volname"
  # 혹시 같은 이름으로 이미 마운트된 게 있으면 정리
  if [ -d "$mount_point" ]; then
    hdiutil detach "$mount_point" >/dev/null 2>&1 || true
  fi
  hdiutil attach "$rw_dmg" -mountpoint "$mount_point" -nobrowse -quiet

  osascript <<OSASCRIPT || echo "    (Finder 꾸미기 실패 - 기능에는 영향 없음, 기본 배치로 진행)"
tell application "Finder"
  tell disk "$volname"
    open
    set current view of container window to icon view
    set toolbar visible of container window to false
    set statusbar visible of container window to false
    set the bounds of container window to {200, 120, 660, 420}
    set viewOptions to the icon view options of container window
    set arrangement of viewOptions to not arranged
    set icon size of viewOptions to 96
    set position of item "$app_base.app" of container window to {110, 150}
    set position of item "Applications" of container window to {350, 150}
    close
    open
    update without registering applications
    delay 1
  end tell
end tell
OSASCRIPT

  sync
  hdiutil detach "$mount_point" -quiet

  echo "==> [$app_base] 압축된 최종 DMG로 변환"
  hdiutil convert "$rw_dmg" -format UDZO -imagekey zlib-level=9 -ov -o "$final_dmg" >/dev/null
  rm -f "$rw_dmg"
  rm -rf "$staging"

  echo "완료: $final_dmg"
}

for app in "${APPS[@]}"; do
  make_dmg "$app"
done

echo ""
echo "모두 완료."
