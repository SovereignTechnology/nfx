// Fixture: sandbox omitted, contextIsolation from a variable, spread hides the rest.
import { BrowserWindow } from 'electron';
const isolate = true;
const base = { nodeIntegration: false };
export const win = new BrowserWindow({
  webPreferences: { ...base, contextIsolation: isolate },
});
