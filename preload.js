'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

/**
 * 드래그된 File 객체의 실제 파일시스템 경로를 가져온다.
 * Electron 32+ 에서는 보안상 File.path가 제거되어 webUtils.getPathForFile을 써야 한다.
 * 그보다 오래된 버전에서는 webUtils가 없으므로 File.path로 폴백한다.
 */
function getPathForFile(file) {
  if (webUtils && typeof webUtils.getPathForFile === 'function') {
    return webUtils.getPathForFile(file);
  }
  return file.path;
}

contextBridge.exposeInMainWorld('api', {
  getPathForFile,
  normalizePaths: (paths) => ipcRenderer.invoke('normalize-paths', paths),
});
