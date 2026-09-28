// Preload: the only bridge between the page and Electron.
// contextIsolation stays on, so the page gets this narrow, explicit API and no
// access to Node or ipcRenderer itself.

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("cuepull", {
  // True only inside the desktop app, so the web build can fall back to plain
  // browser downloads.
  isDesktop: true,

  // Native "Save As" for one track. Returns { saved, canceled, path?, error? }.
  saveTrack: (payload) => ipcRenderer.invoke("cuepull:save-track", payload),

  // Ask once for a folder, then write many tracks into it.
  chooseFolder: () => ipcRenderer.invoke("cuepull:choose-folder"),
  saveTrackTo: (payload) => ipcRenderer.invoke("cuepull:save-track-to", payload),

  // Reveal a saved file in Explorer.
  revealFile: (absPath) => ipcRenderer.invoke("cuepull:reveal", absPath),

  // rekordbox collection exchange.
  pickLibraryFolder: () => ipcRenderer.invoke("cuepull:pick-library"),
  pickRekordboxXml: () => ipcRenderer.invoke("cuepull:pick-rb-xml"),
  pickRekordboxSave: () => ipcRenderer.invoke("cuepull:pick-rb-save"),
});
