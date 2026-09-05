// Fixture: preload exposes only NetworkAdapter methods over contextBridge.
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('networkAdapter', {
  connect: (topic: string) => ipcRenderer.invoke('adapter:connect', topic),
  disconnect: () => ipcRenderer.invoke('adapter:disconnect'),
});
