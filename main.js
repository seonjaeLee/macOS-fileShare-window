'use strict';

const fs = require('fs');
const path = require('path');
// 순수 node로 (node main.js) 실행될 때는 'electron' 패키지가 바이너리 경로 문자열을 반환하므로
// 아래 구조분해는 전부 undefined가 되고, Electron으로 (electron .) 실행될 때만 실제 모듈이 온다.
const { app, BrowserWindow, ipcMain } = require('electron');

/**
 * 파일/폴더 하나의 basename만 NFC로 정규화한다.
 * 이미 NFC면 아무것도 하지 않는다.
 * 같은 이름의 항목이 이미 존재하면 덮어쓰지 않고 에러를 던진다.
 * @returns {string} 정규화 후 최종 경로 (변경 없었으면 원래 경로)
 */
function normalizeOneName(targetPath) {
  const dir = path.dirname(targetPath);
  const base = path.basename(targetPath);
  const nfc = base.normalize('NFC');

  if (nfc === base) {
    return targetPath;
  }

  const newPath = path.join(dir, nfc);

  if (fs.existsSync(newPath)) {
    // APFS 등은 정규화 형태(NFC/NFD)를 구분하지 않고 같은 항목으로 취급하므로,
    // newPath가 존재하더라도 그게 targetPath 자기 자신을 가리키는 것이면 정상 케이스다.
    // dev+ino가 같으면 같은 파일, 다르면 진짜 다른 항목과의 충돌이다.
    const currentStat = fs.lstatSync(targetPath);
    const destStat = fs.lstatSync(newPath);
    const isSameEntry = currentStat.dev === destStat.dev && currentStat.ino === destStat.ino;

    if (!isSameEntry) {
      throw new Error(
        `이름을 바꿀 수 없습니다: "${newPath}" 항목이 이미 존재합니다. (원본: "${targetPath}")`
      );
    }
  }

  fs.renameSync(targetPath, newPath);
  return newPath;
}

/**
 * targetPath가 디렉토리면 하위 항목들을 먼저 재귀적으로 정규화한 뒤,
 * 마지막으로 자기 자신의 이름을 정규화한다.
 * (자식을 먼저 처리해야 부모 경로가 바뀌어도 순회 중 경로가 깨지지 않는다)
 *
 * @param {string} targetPath
 * @param {Array<{from: string, to: string}>} renamed  실제로 이름이 바뀐 항목 기록
 * @returns {string} 이 항목의 최종 경로
 */
function normalizeRecursiveSync(targetPath, renamed) {
  const stat = fs.lstatSync(targetPath);

  if (stat.isDirectory()) {
    const entries = fs.readdirSync(targetPath);
    for (const entry of entries) {
      normalizeRecursiveSync(path.join(targetPath, entry), renamed);
    }
  }

  const finalPath = normalizeOneName(targetPath);
  if (finalPath !== targetPath) {
    renamed.push({ from: targetPath, to: finalPath });
  }
  return finalPath;
}

/**
 * 드래그된 여러 최상위 경로를 각각 독립적으로 정규화한다.
 * 하나가 실패해도 나머지는 계속 처리한다.
 *
 * @param {string[]} inputPaths
 * @returns {{ successes: Array<{ originalPath: string, finalPath: string, renamed: Array }>, errors: Array<{ path: string, message: string }> }}
 */
function normalizePaths(inputPaths) {
  const successes = [];
  const errors = [];

  for (const inputPath of inputPaths) {
    const renamed = [];
    try {
      const finalPath = normalizeRecursiveSync(inputPath, renamed);
      successes.push({ originalPath: inputPath, finalPath, renamed });
    } catch (err) {
      errors.push({ path: inputPath, message: err.message });
    }
  }

  return { successes, errors };
}

module.exports = { normalizeOneName, normalizeRecursiveSync, normalizePaths };

// ---- Electron 부트스트랩 (electron . 으로 실행될 때만 동작) ----
function createWindow() {
  const win = new BrowserWindow({
    width: 900,
    height: 650,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile('index.html');
}

if (app) {
  ipcMain.handle('normalize-paths', (event, inputPaths) => normalizePaths(inputPaths));

  app.whenReady().then(() => {
    createWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}

// ---- 콘솔 테스트용 (IPC 없이 단독 실행: node main.js ...) ----
// 사용법: node main.js <경로1> [<경로2> ...]
if (require.main === module && !process.versions.electron) {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.log('사용법: node main.js <경로1> [<경로2> ...]');
    console.log('예시:   node main.js "./테스트폴더"');
    process.exit(0);
  }

  const { successes, errors } = normalizePaths(args);

  for (const s of successes) {
    console.log(`\n[완료] ${s.originalPath}`);
    console.log(`  최종 경로: ${s.finalPath}`);
    if (s.renamed.length === 0) {
      console.log('  변경 없음 (이미 NFC였음)');
    } else {
      for (const r of s.renamed) {
        console.log(`  이름 변경: ${r.from}  ->  ${r.to}`);
      }
    }
  }

  for (const e of errors) {
    console.error(`\n[실패] ${e.path}`);
    console.error(`  ${e.message}`);
  }
}
