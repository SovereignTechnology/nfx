// Fixture: webPreferences passed by reference — not reviewable inline.
import { BrowserWindow } from 'electron';
import { prefs } from './prefs';
export const win = new BrowserWindow({ webPreferences: prefs });
