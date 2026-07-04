# 한글 파일명 깨짐 방지 앱 — 작업 가이드

> 이 문서는 작업 목표, 배경, 단계별 진행 상황을 기록합니다. 단계가 끝날 때마다 "진행 상황" 섹션을 갱신합니다.

## 목표
맥에서 만든 파일을 윈도우 사용자에게 공유할 때 한글 파일명이 깨지는 문제를 해결하는
**로컬 전용** Electron 앱. 서버 없이 사용자의 맥북에서만 실행한다.

## 배경 (원인 2가지)
1. **NFD 자소분리**: macOS(APFS)는 한글 파일명을 자음/모음 분리형(NFD)으로 저장하는 경우가 있음.
   압축 여부와 상관없이 발생 가능.
2. **zip UTF-8 플래그 누락**: 맥 압축 유틸리티가 만든 zip이 "파일명은 UTF-8"이라는 플래그
   (General Purpose Bit 11)를 세우지 않으면, 윈도우가 CP949로 잘못 해석해서 완전히 깨짐.
   압축할 때만 생기는 더 심한 증상.

## 기능
1. 파일/폴더를 드래그하면 파일명을 NFC(정상 조합형)로 재귀적으로 정규화 (rename)
2. 같은 항목들을 하나의 zip으로 압축 (압축 전 NFC 정규화 먼저 수행)

## 기술 스택
- Electron (최신 안정 버전)
- zip 생성: `archiver` npm 패키지 — 비ASCII 파일명이 있으면 UTF-8 플래그를 자동으로 세워줌
- `contextIsolation: true`, `nodeIntegration: false` (preload.js로 IPC 노출)

## 반드시 지켜야 할 구현 디테일
- Electron 32 이후 버전은 보안상 `File.path`가 제거됨.
  드래그드롭으로 받은 파일의 실제 경로는 preload에서 `webUtils.getPathForFile(file)`로 가져와야 함.
  (구버전 fallback도 같이 넣기)
- 파일명 정규화는 `basename.normalize('NFC')`로 비교 후 다르면만 `fs.renameSync` 실행
  (이미 NFC면 그대로 두기)
- 이름 바꾸다가 같은 이름의 파일이 이미 있으면 덮어쓰지 말고 에러로 알려주기
- 폴더 안에 폴더/파일이 더 있으면 전부 재귀적으로 정규화
- UI는 다크 모드, 드래그존 + "파일명만 정리하기" / "정리해서 압축하기" 버튼 2개, 진행 상태 텍스트 표시

## 진행 방식
전체를 한 번에 짜지 않고 아래 순서로 나눠서 진행. 각 단계 끝나면 결과를 보여주고 대기.
단계마다 오류 유무를 목표에 맞게 검수한다.

1. **1단계**: `package.json` + `main.js` (정규화 함수만 먼저, IPC 없이 콘솔 테스트)
2. **2단계**: `preload.js` + IPC 연결
3. **3단계**: renderer (드래그드롭 UI)
4. **4단계**: zip 압축 기능 추가

## 진행 상황

### 1단계 — 완료 (2026-07-04)
- [package.json](package.json), [main.js](main.js) 작성.
- `normalizeOneName` / `normalizeRecursiveSync` / `normalizePaths` 구현.
  - 자식(파일/하위폴더)을 먼저 재귀 처리한 뒤 자기 자신을 마지막에 처리 (부모 이름이 먼저 바뀌면
    순회 중 경로가 깨지는 문제 방지).
  - 여러 최상위 경로를 각각 독립적으로 처리 (하나 실패해도 나머지는 계속 진행).
- IPC 없이 `node main.js <경로...>` 로 콘솔 테스트 가능하도록 `require.main === module` 가드 추가.
- **검수 중 발견/수정한 버그**: `fs.existsSync(newPath)`만으로 충돌을 판단하면, macOS APFS가
  NFC/NFD를 같은 파일로 취급하기 때문에 정규화 대상 자기 자신도 "이미 존재함"으로 오판해서
  모든 정규화 시도가 가짜 충돌 에러로 실패하는 문제가 있었음. `fs.lstatSync`로 dev/ino를 비교해
  "자기 자신의 정규화"와 "진짜 다른 파일과의 이름 충돌"을 구분하도록 수정.
- **검수 결과**:
  - NFD 자소분리된 파일/폴더/중첩폴더 트리 → 전부 NFC로 정규화 확인 (파이썬 `unicodedata`로 검증)
  - 이미 NFC인 항목 재실행 → "변경 없음"으로 정상 스킵 (idempotent)
  - 존재하지 않는 경로 포함 여러 경로 동시 처리 → 나머지는 정상 처리되고 해당 항목만 에러 리포트
  - `fs.renameSync`가 대상이 이미 있으면 경고 없이 덮어쓴다는 위험성을 직접 확인 → existsSync
    사전 체크가 실제로 데이터 손실을 막는 데 필요함을 검증
  - 진짜 이름 충돌(다른 파일 vs NFD 파일)은 APFS 자체가 두 항목의 동시 생성을 막아서 로컬에서
    직접 재현은 안 됐지만, 핵심 로직(existsSync 판별 + inode 비교, renameSync 덮어쓰기 동작)은
    개별적으로 검증함.

### 2단계 — 완료 (2026-07-04)
- [preload.js](preload.js) 작성: `contextBridge.exposeInMainWorld('api', { getPathForFile, normalizePaths })`.
  - `getPathForFile`: Electron 32+ 는 `webUtils.getPathForFile(file)` 사용, 그보다 낮은 버전은
    `file.path` 폴백.
  - `normalizePaths`: `ipcRenderer.invoke('normalize-paths', paths)`.
- [main.js](main.js)에 Electron 부트스트랩 추가.
  - `require('electron')`을 파일 최상단에서 구조분해했는데, `node main.js`로 순수 node 실행 시
    이 패키지는 바이너리 경로 문자열을 반환하므로 `app`/`BrowserWindow`/`ipcMain`이 전부
    `undefined`가 됨 → `if (app) { ... }`로 감싸서 Electron 런타임에서만 부트스트랩이 동작하도록 함.
  - 1단계에서 만든 콘솔 테스트 블록(`require.main === module`)이 `electron .`으로 실행될 때도
    걸려서 즉시 `process.exit(0)`으로 앱이 죽어버리는 버그 가능성을 발견 → 조건에
    `!process.versions.electron`을 추가해서 순수 node 실행일 때만 CLI 테스트가 돌게 수정.
  - `ipcMain.handle('normalize-paths', ...)`로 1단계의 `normalizePaths` 함수를 그대로 연결.
- [index.html](index.html): 3단계 전까지 쓰는 **임시** IPC 확인용 화면. 경로를 입력하고 버튼을 누르면
  `window.api.normalizePaths([path])`를 호출해 결과 JSON을 화면에 그대로 출력. (실제 드래그드롭
  다크모드 UI는 3단계에서 이 파일을 교체하며 만듦)
- `package.json`의 electron 버전을 최신 안정판인 `^43.0.0`으로 맞춤 (`npm audit`에서
  32.x에 여러 known advisory가 있었고, `webUtils.getPathForFile`은 43에서도 그대로 지원됨).
  Node 20.20.2에서 electron 43 설치 시 `EBADENGINE` 경고(권장 Node ≥22.12)가 뜨지만 설치/구동
  자체는 정상 동작 확인함.
- **검수**: `node --check`로 두 파일 문법 확인, `electron .`을 백그라운드로 직접 띄워서
  main/renderer/gpu-process/network-utility 프로세스가 전부 정상 기동하고 에러 로그 없이 뜨는 것
  확인 후 종료함 (OS 권한 문제로 osascript 창 목록 조회는 안 됐지만 프로세스 트리로 크래시 없음을
  확인).

### 3단계 — 완료 (2026-07-04)
- **요구사항 변경**: 사용자가 다크 모드를 "꼭 하지 않아도 된다"고 확인 → 강제 다크 모드 대신
  `prefers-color-scheme` 미디어쿼리로 시스템 설정에 자동으로 맞추는 방식으로 구현 (라이트/다크
  둘 다 지원하되 어느 쪽도 강제하지 않음).
- 임시 IPC 테스트 화면이었던 [index.html](index.html)을 실제 UI로 교체하고,
  [style.css](style.css) / [renderer.js](renderer.js)로 분리.
  - 드래그존 + "파일명만 정리하기" / "정리해서 압축하기" 버튼 2개 + 상태 텍스트(`<pre id="status">`).
  - "정리해서 압축하기" 버튼은 4단계에서 zip IPC가 생기기 전까지 `disabled` 처리
    (`title="4단계에서 추가될 기능입니다"`).
  - 드롭된 `File` 객체는 `window.api.getPathForFile(file)`로 실제 절대경로를 얻어 목록에 누적.
    같은 항목 중복 드래그 시 중복 제거.
  - 드롭존 밖에 파일을 놓쳐도 Electron 창 전체가 `file://`로 내비게이션되지 않도록
    `window`에 `dragover`/`drop` 기본 동작 preventDefault 처리 (Electron 드래그드롭 구현 시
    흔히 빠뜨리는 부분).
  - "파일명만 정리하기" 클릭 시 `window.api.normalizePaths(currentPaths)` 호출 → 성공/실패
    개수와 각 항목의 변경 여부(또는 에러 메시지)를 상태 영역에 표시.
- **검수**: 정적 파일 서버(임시로만 띄웠다가 종료함, 저장소에는 포함 안 함)로 라이트/다크 모드
  렌더링과 드래그 오버 시 하이라이트 스타일을 스크린샷으로 확인, 콘솔 에러 없음 확인.
  실제 Electron 앱(`electron .`)도 백그라운드로 띄워 main/renderer 프로세스가 에러 없이
  정상 기동하는 것을 확인 후 종료. (다만 macOS Finder에서 실제 파일을 드래그해서
  `webUtils.getPathForFile`이 진짜 절대경로를 돌려주는지는 자동화로 검증할 수 없어 사용자
  확인이 필요함)
- **사용자 실기기 검증 (2026-07-04)**: 같은 파일(`디자인 시안 컨셉정의.md`)을 2단계에서 절대경로를
  직접 타이핑해서 넣었을 때는 `renamed: []`(이미 NFC)였는데, 3단계에서 Finder로 실제
  드래그해서 넣었을 때는 "1개 항목 이름 변경됨"이 나옴. 즉 Finder가 드래그드롭으로 넘겨주는
  파일 경로 문자열 자체가 NFD였다는 뜻 → 배경에서 설명한 "macOS가 한글 파일명을 자소분리로
  저장/전달"하는 현상이 실제로 재현되고, 우리 앱이 이를 정상적으로 감지해 NFC로 고쳤음을
  실사용 환경에서 확인함.

### 4단계 — 완료 (2026-07-04)
- `archiver` 기반 zip 압축 구현.
  - [main.js](main.js): `createZipArchive(sourcePaths, outputZipPath)` 추가, `ipcMain.handle('compress-paths', ...)`에서
    1) `normalizePaths`로 먼저 NFC 정규화 → 2) `dialog.showSaveDialog`로 저장 위치를 사용자가 직접 선택
    (기본 파일명은 항목이 1개면 `<이름>.zip`, 여러 개면 `압축.zip`, 기본 위치는 첫 항목의 부모 폴더) →
    3) 압축 진행. 사용자가 저장 다이얼로그에서 취소하면 `{ cancelled: true }`로 응답.
  - [preload.js](preload.js)에 `compressPaths` 추가.
  - [renderer.js](renderer.js): "정리해서 압축하기" 버튼 활성화, 클릭 시 `window.api.compressPaths(currentPaths)` 호출,
    결과(취소/저장 경로/성공·실패 목록)를 상태 영역에 표시.
- **검수 중 발견/수정한 버그**: "파일명만 정리하기"로 먼저 이름을 바꾼 뒤 이어서 "정리해서 압축하기"를
  누르면, main 프로세스는 이미 실제 파일명을 바꿔놨는데 렌더러가 들고 있는 `currentPaths`는 여전히
  옛날(정규화 전) 경로 문자열이라 다음 호출이 존재하지 않는 경로를 참조하게 되는 문제가 있었음.
  → 정규화/압축 IPC 응답을 받을 때마다 `syncCurrentPathsWithResult`로 화면이 들고 있는 경로 목록을
  실제 최종 경로로 갱신하도록 수정.
- **핵심 요구사항(zip UTF-8 플래그) 저수준 검증**: `archiver`/`compress-commons` 소스를 직접 확인한 결과,
  엔트리 이름을 `Buffer.byteLength(name) !== name.length`로 검사해서 비ASCII 문자가 있으면
  자동으로 General Purpose Bit 11(UTF-8 플래그)을 세우는 것을 확인함 (별도 옵션 설정 불필요).
  실제로 한글 파일이 섞인 zip을 만들어 Python `zipfile`의 `ZipInfo.flag_bits`로 직접 검사한 결과:
  - 한글 파일/폴더 엔트리 → `utf8_flag=True`
  - ASCII 전용 엔트리 → `utf8_flag=False` (불필요한 플래그를 안 세워서 정상)
  - 모든 엔트리 이름이 NFC로 정규화되어 있음을 확인 (정규화 → 압축 순서가 올바르게 적용됨)
- **검수**: `node --check`로 세 파일 문법 확인, 실제 `electron .`을 백그라운드로 띄워 새 IPC 핸들러가
  추가된 상태에서도 크래시 없이 기동하는 것 확인 후 종료.
  단, `dialog.showSaveDialog`는 사용자 상호작용이 필요한 네이티브 UI라 자동화로 끝까지 클릭할 수 없어,
  실제 압축 파일 저장 및 (가능하다면) 윈도우에서 압축 해제해 한글 파일명이 정상인지는 사용자 확인이 필요함.

## 사고 기록: 압축 대상 = 저장 위치로 원본 파일 손상 (2026-07-04)

**증상**: 사용자가 이미 존재하는 zip 파일(`시나리오_문서_셈플.zip`) 하나를 드롭존에 넣고
"정리해서 압축하기"를 눌렀는데, 저장 다이얼로그의 기본 제안 경로가 **입력 파일과 완전히 같은 경로**였고
그대로 저장한 결과 원본 파일이 229바이트짜리(내부에 60바이트짜리 자기 자신 조각만 든) 손상된 파일로
덮어써짐. (이유: 입력이 이미 `.zip` 확장자였는데, 제안 파일명 로직이 `path.parse(name).name + '.zip'`이라
확장자를 뗐다가 다시 붙이면서 원래 이름과 완전히 같아짐)

**근본 원인**: `createZipArchive`가 `fs.createWriteStream(outputZipPath)`로 출력 파일을 여는데, 이 호출
자체가 파일을 즉시 truncate(내용 비움)한다. 출력 경로가 압축 대상 원본과 같으면, `archiver`가 그 원본을
읽어서 zip에 담으려는 시점엔 이미 파일이 비워진 뒤라 내용이 통째로 사라진다. 사용자가 저장 다이얼로그에서
경로를 바꾸지 않고 그대로 저장하면 이 사고가 재현됨.

**복구**: 다행히 손상 시점(20:20) 이전인 20:01:14에 Time Machine 로컬 스냅샷이 있어 사용자에게 Finder ->
Time Machine 진입 -> 해당 시점에서 파일 복원하는 방법을 안내함. (자동화 스크립트로 직접 복구를 시도하지
않고, macOS 표준 기능으로 사용자가 직접 확인하며 복구하도록 함 — 되돌리기 어려운 작업이라 안전한 경로를
선택)

**수정 내용** ([main.js](main.js)):
1. `findOutputCollision(outputPath, sourcePaths)` 추가 — 저장 경로가 압축 대상과 실제로 같은
   파일/폴더를 가리키는지 두 가지 케이스로 검사:
   - 이미 존재하는 파일과 dev+ino가 같음 (APFS의 NFC/NFD·대소문자 무관 특성까지 고려해 정확히 비교)
   - 저장 경로가 압축 대상 폴더 자기 자신이거나 그 내부 (자기 참조)
2. `compress-paths` 핸들러에서 `dialog.showSaveDialog`로 경로를 받은 직후, `createZipArchive` 호출
   **전에** 이 충돌 검사를 수행. 충돌이 있으면 압축을 아예 시작하지 않고 에러로 알려줌
   (원본에 어떤 쓰기도 일어나지 않도록 보장).
3. 기본 제안 파일명에 `" (압축)"` 접미사를 붙여서, 입력이 이미 `.zip`이어도 기본값 자체가 원본과
   같아지지 않도록 함 (근본 방어는 위 1번 검사지만, 애초에 위험한 기본값을 제안하지 않는 것도 함께 적용).

**검수**: 실제 사고를 그대로 재현하는 테스트(같은 이름의 `.zip`을 자기 자신으로 저장 시도)로
1) 충돌이 정상적으로 감지되는지, 2) 그 경우 원본 파일이 바이트 단위로 전혀 변경되지 않는지(`shasum` 비교)
확인함. 추가로 (a) 다른 이름으로는 정상 압축됨, (b) 압축 대상 폴더 내부에 저장하려는 자기참조 케이스도
차단됨, (c) 압축 대상과 무관한 기존 파일을 덮어쓰는 것(정상적인 사용자 의도)은 차단하지 않음을 각각
확인함.

## 사용자 실기기(윈도우) 검증 성공 + 후속 개선 (2026-07-04)

Time Machine으로 원본 복구 후, 폴더를 다시 압축해서 실제로 윈도우 PC로 옮겨 압축을 풀어본 결과
한글 파일명이 정상적으로 보이는 것을 확인함 (macOS → Windows 한글 파일명 깨짐 문제, 이 프로젝트의
핵심 목표가 실사용 환경에서 검증됨).

사용자 피드백 2가지를 반영해 추가로 개선함:

1. **폴더 하나만 압축할 때 폴더 한 겹이 더 생기는 문제**: 기존엔 `archive.directory(sourcePath, name)`로
   항상 폴더 이름을 zip 최상위 엔트리로 감쌌기 때문에, 압축을 풀면 "그 폴더/실제파일들" 구조가 되어
   윈도우 탐색기가 압축 해제 시 만드는 폴더까지 합쳐 두 겹으로 보였음.
   → [main.js](main.js)의 `createZipArchive`에서, 압축 대상이 **폴더 1개뿐**일 때는
   `archive.directory(sourcePath, false)`로 내용물을 zip 최상위에 바로 풀어 넣도록 수정 (archiver가
   지원하는 옵션). 여러 항목(파일+폴더 등)을 함께 압축할 때는 서로 이름이 겹치지 않도록 기존처럼 각자의
   이름으로 최상위에 둠. 두 경우 모두 실제 zip 내부 엔트리 목록을 python으로 확인해 의도대로 나오는 것을
   검증함.
2. **기본 저장 파일명의 `" (압축)"` 접미사 제거 요청**: 확장자가 `.zip`으로 이미 구분되니 접미사가
   불필요하다는 피드백 → 제거하고 원래대로 `<원본이름>.zip`으로 되돌림. 이 경우 입력이 이미 `.zip`
   파일이면 다시 원본과 이름이 같아질 수 있지만, 위 사고 이후 추가된 `findOutputCollision` 하드 가드가
   저장 단계에서 여전히 막아주므로 안전함 (기본값을 다시 위험해 보이게 되돌려도, 실제 데이터 손상으로는
   이어지지 않음을 재확인하는 테스트를 거침).

## 5단계: 독(Dock)용 .app 패키징 + 아이콘 (2026-07-04)

사용자가 터미널의 `npm start` 대신 독에 올려두고 더블클릭으로 쓸 수 있는 `.app`을 요청함.

### 아이콘
- [build/icon.svg](build/icon.svg): 파란 스퀴클 배경 + 흰 문서 카드 + 가운데 한글 "가" + 초록 체크 배지.
- [build-icon.sh](build-icon.sh): `rsvg-convert`로 크기별 png를 만들고 `iconutil`로 `build/icon.icns` 생성.
  아이콘 디자인을 바꿀 때만 실행하면 됨. 결과물 `build/icon.icns`는 저장소에 커밋되어 있어
  `build-app.sh`가 바로 쓸 수 있음. (중간 산출물 `build/AppIcon.iconset/`은 .gitignore 처리)

### electron-builder가 만든 .app이 실행 즉시 크래시하는 문제 (핵심 트러블슈팅)
처음엔 `electron-builder`로 `.app`을 만들었으나, 더블클릭/`open` 시 앱이 뜨자마자
`EXC_BREAKPOINT (SIGTRAP)`(종료코드 133)로 죽었음. 크래시 로그 스택은 V8 JIT 초기화
(`v8::internal::compiler::CompilationDependencies...` / `node::crypto::SecureContext::Init`) 지점.

**원인 규명 (단계적 이분 탐색)**:
- 이건 Electron 자체의 알려진 이슈로, macOS 26 + Apple Silicon에서 tightened MAP_JIT 강제로 인해
  발생 (https://github.com/electron/electron/issues/51351). Node 20에서 electron 43을 쓸 때
  `EBADENGINE` 경고가 났던 것과도 무관하지 않은, 신형 OS/하드웨어 조합 문제.
- 가설 검증 결과:
  - `hardenedRuntime: true→false` 로 바꿔도 여전히 크래시(133). → hardened runtime 문제 아님.
  - JIT entitlements(allow-jit 등)를 전부 제거하고 재서명해도 크래시. → entitlements 문제 아님.
  - **반면** `npm start`가 쓰는 `node_modules/electron/dist/Electron.app`은 정상. 이 원본을
    다른 곳에 복사해 일반 ad-hoc으로 재서명한 뒤 우리 코드로 실행해도 정상. → 재서명/서명 종류 문제 아님.
  - 결론: 문제는 electron-builder가 만든 **번들 자체**(재패키징·재서명 결과물)이고, npm이 내려받은
    원본 Electron.app은 macOS 26에서도 정상 동작함.

**해결책** ([build-app.sh](build-app.sh)):
- electron-builder를 버리고(의존성에서 제거), 정상 동작이 검증된 `node_modules/electron/dist/Electron.app`을
  그대로 복사한 뒤 우리 앱 코드/아이콘/이름만 얹어서 `.app`을 조립.
- 내부 실행 파일과 헬퍼 이름은 원본("Electron") 그대로 두고 **껍데기(.app 폴더명·표시 이름)만 한글**로 함.
  (실행 파일 이름을 한글+공백으로 바꾸는 시도는 불안정했음. Dock/메뉴바 표시는 `CFBundleName`/폴더명이
  결정하므로 내부 바이너리명을 굳이 바꿀 필요 없음.)
- 앱 코드는 `Contents/Resources/app/`에 폴더로 배치(asar 미사용), 런타임 의존성은 `archiver`만
  (`npm install --omit=dev`) 담아 electron/electron-builder가 섞이지 않게 함.
- 마지막에 `codesign --force --deep --sign -` 로 ad-hoc 재서명.

**검수**:
- `open`으로 실행 후 35초간 5초 간격으로 프로세스 수를 관찰 → main+GPU+renderer+utility 4개 프로세스가
  안정적으로 유지되고, 크래시 로그도 생성되지 않음(정상).
- 진단 로그를 임시 삽입해 `app ready → createWindow → loadFile → did-finish-load OK`까지 도달함을 확인
  (index.html이 실제로 정상 로드됨).
- 로컬 빌드 앱은 quarantine 속성이 없어 Gatekeeper가 첫 실행을 막지 않음(`xattr`에 quarantine 없음 확인).
  `spctl`은 미공증이라 "rejected"로 나오지만, 이는 **다른 Mac으로 배포**할 때만 의미가 있고 본인이 만든
  로컬 전용 앱에는 영향 없음.
- 디버깅 중 프로세스/크래시로그 탐지가 한 번 어긋났던 원인이 바로 이 앱이 다루는 그 문제였음:
  `ps`/`find` 출력의 한글 경로가 NFD로 저장돼 있어, NFC로 작성한 grep 패턴과 매칭 실패. ASCII 부분
  (`fileShare-window/dist`)으로 매칭하도록 바꿔 해결. (프로젝트 주제가 디버깅에서도 재현된 셈.)

### 설치/사용 방법 (사용자용)
1. 최초 1회: 터미널에서 프로젝트 폴더로 이동 후 `npm install` (electron 등 준비).
2. 빌드: `npm run dist` (내부적으로 `./build-app.sh` 실행) → `dist/한글 파일명 정리.app` 생성.
3. 생성된 `한글 파일명 정리.app`을 Finder에서 **응용 프로그램 폴더**로 드래그.
4. 처음엔 더블클릭(또는 우클릭→열기)으로 실행. 실행되면 독의 앱 아이콘을 우클릭 →
   "옵션 → Dock에 유지"로 고정하면 계속 독에서 바로 쓸 수 있음.

---

## 다음 작업 — 공개(public) 전환 및 지인 공유 준비 (TODO)

> 오늘(2026-07-04)은 여기서 중단. 아래는 저장소를 공개로 바꾸고 지인에게 배포할 때 할 일.
> 현재 저장소는 private, 앱은 로컬 빌드로만 정상 동작하는 상태(독 설치까지 완료).

### 0. 공개 전 반드시: 민감/개인 정보 스크럽 (우선순위 높음)
- 현재 커밋된 파일 중 **GUIDE.md**에 실제 작업 파일명이 예시로 남아 있음:
  - `시나리오_문서_셈플.zip` (사고 기록 섹션)
  - `디자인 시안 컨셉정의.md` (3단계 실기기 검증 섹션)
  - → 공개 전 `문서A.zip`, `예시파일.md` 같은 일반 예시로 치환할 것.
    (다행히 클라이언트명 "삼성증권" 등은 커밋된 파일엔 없음 — 디버깅 중 `ls` 출력에만 스쳤고 저장소엔 미포함.)
- 커밋 히스토리에도 위 파일명이 남으므로, 완전히 지우려면 히스토리 재작성(git filter-repo)까지 고려.
  지인 공유 수준이면 최신 파일만 치환해도 실용상 충분.
- appId/번들ID의 `kr.seonjae`는 의도된 식별자라 그대로 둬도 무방.

### 1. 최종 사용자용 README.md 작성
- 지금의 GUIDE.md는 "개발 작업 로그"라 일반 사용자에겐 부적합.
- 별도 README.md에 (한글로) 다음만 간단히:
  - 이 앱이 뭘 해결하는지 (맥→윈도우 한글 파일명 깨짐)
  - 스크린샷 1~2장
  - 설치/실행법 (아래 3번 배포 방식에 맞춰)

### 2. 라이선스 추가
- 개인 유틸이면 MIT 정도면 충분. LICENSE 파일 추가.

### 3. 배포 방식 결정 (가장 고민이 필요한 부분)
현재 `.app`은 **ad-hoc 서명**이라, 만든 본인 맥에서는 잘 뜨지만 **다른 사람이 받아서 열면**
macOS Gatekeeper가 "확인되지 않은 개발자"로 막고, 다운로드 파일엔 quarantine 속성이 붙어
Apple Silicon에선 더 까다로움. 선택지:
- **(A) 소스 공유 + 각자 빌드**: 지인이 `git clone` → `npm install` → `npm run dist`.
  가장 확실하지만 지인이 터미널/Node를 다뤄야 함(비개발자에겐 어려움).
- **(B) 빌드된 .app을 zip으로 배포 + 우회 안내**: 받는 사람이 "우클릭 → 열기"(최초 1회) 또는
  `xattr -dr com.apple.quarantine <앱>` 실행. 안내만 잘 하면 비개발자도 가능. 무료.
- **(C) 정식 배포**: Apple Developer Program($99/년) 가입 → Developer ID 서명 + notarization →
  아무 경고 없이 열림. 가장 깔끔하지만 유료.
- 지인 공유 목적이면 **(B)** 가 현실적. README에 "우클릭→열기" 스크린샷 포함 권장.

### 4. 아키텍처/호환성 주의
- 현재 빌드는 **Apple Silicon(arm64) 전용**(빌드한 맥의 node_modules Electron을 복사하므로).
  인텔 맥 지인에게 주려면 x64용도 따로 빌드 필요.
- macOS 26 + Apple Silicon에서 electron-builder 산출물이 크래시하는 이슈(5단계 참고)가
  아직 살아있으므로, DMG/정식 패키징으로 갈 때 이 문제가 해결됐는지 재확인 필요
  (Electron 업스트림 이슈 https://github.com/electron/electron/issues/51351 상태 확인).

### 5. GitHub 저장소 공개 전환
- 위 0~2 정리 후 GitHub → Settings → Danger Zone → Change visibility → Public.
- Release 탭에 (B) 방식이면 빌드된 앱 zip을 첨부하면 지인이 받기 편함.

---

## 다음 작업 — 윈도우 호환성 경고 기능 (TODO)

> 2026-07-04 실사용 중 발견한 문제. 삼성증권챗봇 폴더(node_modules 포함, 39,847개, 1GB) 압축 후
> 윈도우에서 "압축폴더가 올바르지 않습니다" 오류 발생. 원인은 경로 길이가 윈도우 MAX_PATH(260자)
> 초과 파일이 3,940개 포함돼 있었기 때문.

### 추가할 기능

1. **압축 전 경고**: 드래그된 항목 안에 아래 상황이 감지되면 압축 전에 사용자에게 안내
   - 경로 길이 200자 이상인 파일이 있을 때 (윈도우 MAX_PATH 260자 초과 위험)
   - `node_modules` 폴더가 포함될 때 (개발용 폴더, 공유 불필요 + 경로 깊음)

2. **경고 메시지 예시**
   - "node_modules 폴더가 포함되어 있습니다. 윈도우에서 압축을 풀 수 없을 수 있어요. 계속할까요?"
   - "경로가 200자를 넘는 파일이 N개 있습니다. 윈도우에서 압축 해제 시 오류가 날 수 있어요."

3. **"파일명만 정리하기"에도 동일 경고 적용** (정규화는 되지만 윈도우 전달 시 문제될 수 있으므로)

---

## 다음 작업 — "다른 파일 정리하기" 초기화 버튼 (TODO)

> 2026-07-04 사용자 피드백. 작업이 끝난 뒤 새 파일을 처리하려면 앱을 껐다 켜거나
> 새로 드래그해야 해서 불편함.

### 추가할 기능

- 드래그존 아래 또는 결과 영역에 **"다른 파일 정리하기"** 버튼 추가
- 클릭 시: 파일 목록(`currentPaths`) 초기화 + 상태 텍스트 초기화 → 드래그존 초기 상태로 복귀
- 표시 조건: 압축/정리 완료 후에만 보이게 하거나, 목록에 항목이 있을 때 항상 표시 (둘 다 무방)
