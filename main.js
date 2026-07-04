'use strict';

const fs = require('fs');
const path = require('path');
const archiver = require('archiver');
// 순수 node로 (node main.js) 실행될 때는 'electron' 패키지가 바이너리 경로 문자열을 반환하므로
// 아래 구조분해는 전부 undefined가 되고, Electron으로 (electron .) 실행될 때만 실제 모듈이 온다.
const { app, BrowserWindow, ipcMain, dialog } = require('electron');

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

/**
 * 최상위 경로들(파일 또는 폴더)을 하나의 zip으로 압축한다.
 * 여러 항목을 함께 압축할 때는 서로 이름이 겹치지 않도록 각자의 basename을 최상위 엔트리로 둔다.
 * 반면 폴더 하나만 단독으로 압축할 때는 그 폴더 이름으로 한 번 더 감싸지 않고,
 * 폴더 안의 내용물을 바로 zip 최상위에 풀어 넣는다 (압축 풀었을 때 폴더가 한 겹 더 생기는 것을 방지).
 * (파일명에 비ASCII 문자가 있으면 archiver가 자동으로 UTF-8 플래그(General Purpose Bit 11)를 세운다)
 *
 * @param {string[]} sourcePaths
 * @param {string} outputZipPath
 * @returns {Promise<void>}
 */
function createZipArchive(sourcePaths, outputZipPath) {
  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(outputZipPath);
    const archive = archiver('zip', { zlib: { level: 9 } });

    output.on('close', () => resolve());
    output.on('error', (err) => reject(err));
    archive.on('error', (err) => reject(err));

    archive.pipe(output);

    const isSingleFolder = sourcePaths.length === 1 && fs.lstatSync(sourcePaths[0]).isDirectory();

    for (const sourcePath of sourcePaths) {
      const stat = fs.lstatSync(sourcePath);
      const name = path.basename(sourcePath);
      if (stat.isDirectory()) {
        archive.directory(sourcePath, isSingleFolder ? false : name);
      } else {
        archive.file(sourcePath, { name });
      }
    }

    archive.finalize();
  });
}

/**
 * 압축 저장 경로가 압축 대상(원본) 항목과 실제로 같은 파일/폴더를 가리키는지 확인한다.
 * 같으면 그대로 진행 시 fs.createWriteStream이 원본을 열자마자 비워버려서(truncate)
 * archiver가 그 원본을 읽으려 할 때 이미 내용이 사라진 상태가 되어 데이터가 손상된다.
 *
 * @param {string} outputPath
 * @param {string[]} sourcePaths
 * @returns {string|null} 충돌한 원본 경로, 없으면 null
 */
function findOutputCollision(outputPath, sourcePaths) {
  // 케이스 1: outputPath가 이미 존재하는 원본 파일과 완전히 같은 항목을 가리킴.
  // (APFS는 NFC/NFD, 대소문자를 구분하지 않고 같은 항목으로 취급하므로 dev+ino로 비교해야 정확하다)
  if (fs.existsSync(outputPath)) {
    const outStat = fs.lstatSync(outputPath);
    for (const src of sourcePaths) {
      if (!fs.existsSync(src)) continue;
      const srcStat = fs.lstatSync(src);
      if (srcStat.dev === outStat.dev && srcStat.ino === outStat.ino) {
        return src;
      }
    }
  }

  // 케이스 2: outputPath가 압축 대상 폴더 자기 자신이거나 그 내부임 (자기 참조).
  const outputResolved = path.resolve(outputPath);
  for (const src of sourcePaths) {
    const srcResolved = path.resolve(src);
    const stat = fs.lstatSync(src);
    if (stat.isDirectory()) {
      const withSep = srcResolved.endsWith(path.sep) ? srcResolved : srcResolved + path.sep;
      if (outputResolved === srcResolved || outputResolved.startsWith(withSep)) {
        return src;
      }
    }
  }

  return null;
}

module.exports = {
  normalizeOneName,
  normalizeRecursiveSync,
  normalizePaths,
  createZipArchive,
  findOutputCollision,
};

// ---- Electron 부트스트랩 (electron . 으로 실행될 때만 동작) ----
let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 900,
    height: 650,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.loadFile('index.html');
}

if (app) {
  ipcMain.handle('normalize-paths', (event, inputPaths) => normalizePaths(inputPaths));

  ipcMain.handle('compress-paths', async (event, inputPaths) => {
    // 압축 전에 항상 먼저 NFC로 정규화한다.
    const { successes, errors } = normalizePaths(inputPaths);

    if (successes.length === 0) {
      return { cancelled: false, savedTo: null, successes, errors };
    }

    const firstDir = path.dirname(successes[0].finalPath);
    // 확장자가 .zip으로 붙기 때문에 이름에 별도로 "(압축)" 같은 표시는 붙이지 않는다.
    // 압축 대상과 저장 경로가 실제로 같아지는 위험한 경우는 findOutputCollision이 별도로 막아준다.
    const suggestedName =
      successes.length === 1 ? `${path.parse(successes[0].finalPath).name}.zip` : '압축.zip';

    const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
      title: '압축 파일 저장',
      defaultPath: path.join(firstDir, suggestedName),
      filters: [{ name: 'Zip', extensions: ['zip'] }],
    });

    if (canceled || !filePath) {
      return { cancelled: true, savedTo: null, successes, errors };
    }

    const sourcePaths = successes.map((s) => s.finalPath);
    const collision = findOutputCollision(filePath, sourcePaths);
    if (collision) {
      errors.push({
        path: filePath,
        message: `저장 위치가 압축 대상("${collision}")과 같은 항목입니다. 원본이 손상될 수 있어 압축을 진행하지 않았습니다. 다른 이름이나 위치를 선택해주세요.`,
      });
      return { cancelled: false, savedTo: null, successes, errors };
    }

    try {
      await createZipArchive(sourcePaths, filePath);
      return { cancelled: false, savedTo: filePath, successes, errors };
    } catch (err) {
      errors.push({ path: filePath, message: `압축 실패: ${err.message}` });
      return { cancelled: false, savedTo: null, successes, errors };
    }
  });

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
