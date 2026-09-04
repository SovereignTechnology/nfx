// Fixture: the posture build-plan §7 requires, written explicitly.
import { app, BrowserWindow } from 'electron';
import { join } from 'node:path';

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    // "contextIsolation: false" in a comment must not trip the lint
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      nodeIntegrationInWorker: false,
      preload: join(__dirname, 'preload.js'),
    },
  });
  win.loadFile('index.html');
  return win;
}

void app.whenReady().then(createWindow);
