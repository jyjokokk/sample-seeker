import path from "node:path";
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  nativeImage,
  type UtilityProcess,
  utilityProcess,
} from "electron";
import { AbletonOscAdapter } from "./daw/ableton-osc";
import { type DawAdapter, type DawState, emptyState } from "./daw/types";

let win: BrowserWindow | null = null;
let engine: UtilityProcess;
let daw: DawAdapter;
let dawState: DawState = emptyState();

// --- Engine RPC (main <-> utility process) --------------------------------

let nextId = 1;
const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();

function startEngine() {
  engine = utilityProcess.fork(path.join(__dirname, "engine-process.js"), [], {
    env: { ...process.env, SF_DATA_DIR: app.getPath("userData") },
  });
  engine.on("message", (msg: any) => {
    if (msg.id) {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? p?.reject(new Error(msg.error)) : p?.resolve(msg.result);
    } else if (msg.event) {
      win?.webContents.send(msg.event, msg.data); // forward events to the UI
    }
  });
}

function call(method: string, ...args: unknown[]): Promise<any> {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    engine.postMessage({ id, method, args });
  });
}

// --- DAW integration -------------------------------------------------------

async function startDaw() {
  daw = new AbletonOscAdapter(); // the only line that knows which DAW this is
  daw.onState((s) => {
    dawState = s;
    win?.webContents.send("daw-state", s);
  });
  await daw.connect().catch((e) => console.error(`${daw.name}: ${e.message}`));
}

// --- Window & IPC (main <-> renderer) -------------------------------------

function createWindow() {
  win = new BrowserWindow({
    width: 1000,
    height: 700,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      sandbox: true,
    },
  });
  win.loadFile(path.join(__dirname, "renderer", "index.html"));
}

ipcMain.handle("engine", (_e, method: string, args: unknown[]) => {
  if (!["search", "similar", "roots", "index"].includes(method))
    throw new Error(`not allowed: ${method}`);
  return call(method, ...args);
});

ipcMain.handle("add-folder", async () => {
  const r = await dialog.showOpenDialog(win!, { properties: ["openDirectory"] });
  for (const p of r.filePaths) await call("addRoot", p);
  return call("roots");
});

ipcMain.handle("daw:get", () => dawState);

// Native file drag-out: this is how a result gets dropped into the DAW.
ipcMain.on("drag", (e, filePath: string) => {
  e.sender.startDrag({
    file: filePath,
    icon: nativeImage.createFromPath(path.join(__dirname, "renderer", "drag.png")),
  });
});

app.whenReady().then(() => {
  startEngine();
  createWindow();
  startDaw();
});

app.on("window-all-closed", () => app.quit());
app.on("before-quit", () => void daw?.dispose());
