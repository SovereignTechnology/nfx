// Fixture: every forbidden setting in one place.
const { BrowserWindow } = require('electron');
const remote = require('@electron/remote/main');

const win = new BrowserWindow({
  webPreferences: {
    contextIsolation: false,
    nodeIntegration: true,
    sandbox: false,
    webSecurity: false,
    allowRunningInsecureContent: true,
    enableRemoteModule: true,
    nodeIntegrationInWorker: true,
    nodeIntegrationInSubFrames: true,
    experimentalFeatures: true,
    webviewTag: true,
  },
});
module.exports = { win, remote };
