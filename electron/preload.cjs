// 桌面端预加载脚本：在隔离上下文里给页面暴露少量原生能力。
// 只暴露白名单方法，不开放 node 能力（contextIsolation: true）。
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('arkDesktop', {
  isElectron: true,
  /**
   * 把一条消息里的图片/文件作为「原生文件」拖出去（可拖到桌面、资源管理器、其它应用）。
   * 必须同步调用（ipcRenderer.sendSync）——Electron 的 startDrag 要求处于用户拖动手势内。
   */
  dragOut(payload) {
    try { return ipcRenderer.sendSync('ark:drag-out', payload || {}); }
    catch (e) { return { ok: false, error: String(e?.message || e) }; }
  },
  // 自动更新（异步 IPC）
  onOpenUpdate(fn) { ipcRenderer.on('ark:open-update', () => fn()); },
  updateCheck()   { return ipcRenderer.invoke('ark:update-check'); },
  updatePrepare() { return ipcRenderer.invoke('ark:update-prepare'); },
  updateApply()   { return ipcRenderer.invoke('ark:update-apply'); },
  updateSkip(v)   { return ipcRenderer.invoke('ark:update-skip', v); },
  updateRollback(){ return ipcRenderer.invoke('ark:update-rollback'); }
});
