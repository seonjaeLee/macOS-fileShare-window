'use strict';

const dropzone = document.getElementById('dropzone');
const fileListEl = document.getElementById('fileList');
const normalizeBtn = document.getElementById('normalizeBtn');
const zipBtn = document.getElementById('zipBtn');
const statusEl = document.getElementById('status');
const resetRow = document.getElementById('resetRow');
const resetBtn = document.getElementById('resetBtn');
const compatWarning = document.getElementById('compatWarning');

let currentPaths = [];

// Electron 창 밖/드롭존 밖에 파일을 놓쳤을 때 file:// 로 통째로 내비게이션되는 걸 막는다.
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => e.preventDefault());

['dragenter', 'dragover'].forEach((evt) => {
  dropzone.addEventListener(evt, (e) => {
    e.preventDefault();
    dropzone.classList.add('dragover');
  });
});

['dragleave', 'dragend'].forEach((evt) => {
  dropzone.addEventListener(evt, (e) => {
    e.preventDefault();
    dropzone.classList.remove('dragover');
  });
});

dropzone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropzone.classList.remove('dragover');

  const files = Array.from(e.dataTransfer.files);
  const paths = files.map((f) => window.api.getPathForFile(f));

  // 중복 제거 (같은 항목을 두 번 드래그했을 경우)
  for (const p of paths) {
    if (!currentPaths.includes(p)) {
      currentPaths.push(p);
    }
  }

  renderFileList();
  clearStatus();
  resetRow.hidden = false;
  compatWarning.textContent = '';
});

function renderFileList() {
  fileListEl.innerHTML = '';
  for (const p of currentPaths) {
    const li = document.createElement('li');
    li.textContent = p;
    fileListEl.appendChild(li);
  }
  const hasItems = currentPaths.length > 0;
  normalizeBtn.disabled = !hasItems;
  zipBtn.disabled = !hasItems;
}

function clearStatus() {
  statusEl.textContent = '';
}

function setStatus(text) {
  statusEl.textContent = text;
}

function setButtonsDisabled(disabled) {
  normalizeBtn.disabled = disabled || currentPaths.length === 0;
  zipBtn.disabled = disabled || currentPaths.length === 0;
}

// 정규화(이름 변경)는 main 프로세스에서 실제로 파일을 rename하므로,
// 화면이 들고 있는 currentPaths도 실제 최종 경로로 갱신해야 다음 조작(재정규화/압축)이
// 존재하지 않는 예전 경로를 가리키지 않는다.
function syncCurrentPathsWithResult(result) {
  const originalToFinal = new Map(result.successes.map((s) => [s.originalPath, s.finalPath]));
  currentPaths = currentPaths.map((p) => originalToFinal.get(p) ?? p);
  renderFileList();
}

function renderNormalizeResult(result) {
  const { successes, errors } = result;
  const lines = [];

  for (const s of successes) {
    if (s.renamed.length === 0) {
      lines.push(`[완료] ${s.finalPath} (변경 없음, 이미 정상 이름)`);
    } else {
      lines.push(`[완료] ${s.finalPath} (${s.renamed.length}개 항목 이름 변경됨)`);
    }
  }

  for (const e of errors) {
    lines.push(`[실패] ${e.path}\n  → ${e.message}`);
  }

  const summary = `총 ${successes.length + errors.length}개 중 성공 ${successes.length}개, 실패 ${errors.length}개\n\n`;
  setStatus(summary + lines.join('\n'));
}

function renderCompressResult(result) {
  const { cancelled, savedTo, successes, errors } = result;

  if (cancelled) {
    setStatus('압축이 취소되었습니다 (저장 위치를 선택하지 않음).');
    return;
  }

  const lines = [];
  for (const s of successes) {
    lines.push(`[포함] ${s.finalPath}${s.renamed.length > 0 ? ` (${s.renamed.length}개 항목 이름 변경됨)` : ''}`);
  }
  for (const e of errors) {
    lines.push(`[실패] ${e.path}\n  → ${e.message}`);
  }

  const header = savedTo
    ? `압축 완료: ${savedTo}\n\n`
    : '압축 실패: 저장된 파일이 없습니다.\n\n';

  setStatus(header + lines.join('\n'));
}

/**
 * @returns {Promise<boolean>} 윈도우 호환성 문제가 있으면 true (경고 텍스트도 갱신함)
 */
async function updateCompatWarning() {
  if (currentPaths.length === 0) {
    compatWarning.textContent = '';
    return false;
  }
  const { longPathCount, nodeModulesDirs } = await window.api.checkWindowsCompat(currentPaths);
  const hasIssue = nodeModulesDirs.length > 0 || longPathCount > 0;
  compatWarning.textContent = hasIssue
    ? '최대 경로표시 문자가 200자를 넘지 않도록 해주세요.\n윈도우에서 압축 해제를 할 수 없게 됩니다.'
    : '';
  return hasIssue;
}

resetBtn.addEventListener('click', () => {
  currentPaths = [];
  renderFileList();
  clearStatus();
  resetRow.hidden = true;
  compatWarning.textContent = '';
});

normalizeBtn.addEventListener('click', async () => {
  if (currentPaths.length === 0) return;

  setButtonsDisabled(true);
  setStatus('호환성 확인 중...');
  const hasIssue = await updateCompatWarning();
  if (hasIssue) {
    setStatus('문제를 해결한 뒤 다시 시도해주세요.');
    setButtonsDisabled(false);
    return;
  }

  setStatus('파일명 정리 중...');

  try {
    const result = await window.api.normalizePaths(currentPaths);
    syncCurrentPathsWithResult(result);
    renderNormalizeResult(result);
  } catch (err) {
    setStatus(`에러 발생: ${err.message}`);
  } finally {
    setButtonsDisabled(false);
  }
});

zipBtn.addEventListener('click', async () => {
  if (currentPaths.length === 0) return;

  setButtonsDisabled(true);
  setStatus('호환성 확인 중...');
  const hasIssue = await updateCompatWarning();
  if (hasIssue) {
    setStatus('문제를 해결한 뒤 다시 시도해주세요.');
    setButtonsDisabled(false);
    return;
  }

  setStatus('파일명 정리 후 압축 중...');

  try {
    const result = await window.api.compressPaths(currentPaths);
    syncCurrentPathsWithResult(result);
    renderCompressResult(result);
  } catch (err) {
    setStatus(`에러 발생: ${err.message}`);
  } finally {
    setButtonsDisabled(false);
  }
});
