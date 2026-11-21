import { contextBridge, ipcRenderer } from "electron";

// The renderer's only door to the outside world. Typed in renderer/global.d.ts.
contextBridge.exposeInMainWorld("sf", {
  call: (method: string, ...args: unknown[]) => ipcRenderer.invoke("engine", method, args),
  addFolder: () => ipcRenderer.invoke("add-folder"),
  getDawState: () => ipcRenderer.invoke("daw:get"),
  startDrag: (path: string) => ipcRenderer.send("drag", path),
  on: (channel: "engine-status" | "index-progress" | "daw-state", cb: (data: any) => void) =>
    ipcRenderer.on(channel, (_e, data) => cb(data)),
});
