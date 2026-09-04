// Fixture: options object declared separately, still with a literal webPreferences.
import { BrowserWindow } from 'electron';

const options = {
  show: false,
  webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
};
export const win = new BrowserWindow(options);
