/**
 * Electron utility process: owns the Engine (model + DB) so heavy work never
 * blocks the UI. Receives { id, method, args } from main, replies { id, result | error },
 * and pushes { event, data } for things like index progress.
 */
import { join } from "node:path";
import { Engine } from "@sample-finder/core";

const port = process.parentPort;
const dataDir = process.env.SF_DATA_DIR!;

const emit = (event: string, data: unknown) => port.postMessage({ event, data });

const ready = Engine.open({
  dbPath: join(dataDir, "index.db"),
  modelCacheDir: join(dataDir, "models"),
});
ready.then(
  () => emit("engine-status", { state: "ready" }),
  (e) => emit("engine-status", { state: "error", message: String(e?.message ?? e) }),
);

port.on("message", async ({ data }) => {
  const { id, method, args = [] } = data as { id: number; method: string; args: any[] };
  try {
    const engine = await ready;
    let result: unknown;
    switch (method) {
      case "search":  result = await engine.search(args[0], args[1]); break;
      case "similar": result = await engine.similar(args[0], args[1]); break;
      case "addRoot": result = engine.addRoot(args[0]); break;
      case "roots":   result = engine.roots(); break;
      case "index":   await engine.index((p) => emit("index-progress", p)); break;
      default: throw new Error(`unknown method ${method}`);
    }
    port.postMessage({ id, result });
  } catch (e) {
    port.postMessage({ id, error: String((e as Error)?.message ?? e) });
  }
});
