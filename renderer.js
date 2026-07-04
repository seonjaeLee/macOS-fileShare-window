'use strict';

const dropzone = document.getElementById('dropzone');
const fileListEl = document.getElementById('fileList');
const normalizeBtn = document.getElementById('normalizeBtn');
const zipBtn = document.getElementById('zipBtn');
const statusEl = document.getElementById('status');

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
}

function clearStatus() {
  statusEl.textContent = '';
}

function setStatus(text) {
  statusEl.textContent = text;
}

function setButtonsDisabled(disabled) {
  normalizeBtn.disabled = disabled || currentPaths.length === 0;
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

normalizeBtn.addEventListener('click', async () => {
  if (currentPaths.length === 0) return;

  setButtonsDisabled(true);
  setStatus('파일명 정리 중...');

  try {
    const result = await window.api.normalizePaths(currentPaths);
    renderNormalizeResult(result);
  } catch (err) {
    setStatus(`에러 발생: ${err.message}`);
  } finally {
    setButtonsDisabled(false);
  }
});

// 압축 기능은 4단계에서 연결 예정. 지금은 비활성화 상태로 둔다.
zipBtn.disabled = true;
