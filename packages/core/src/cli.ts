#!/usr/bin/env node
/**
 * Dev CLI, for testing the engine without the app.
 *   sf add <folder> | sf index | sf search "<query>" | sf similar <file>
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { Engine } from "./engine";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { db: { type: "string", default: join(homedir(), ".sample-finder", "index.db") } },
});
const [cmd, ...args] = positionals;

async function main() {
  const engine = await Engine.open({ dbPath: values.db! });
  try {
    switch (cmd) {
      case "add":     args.forEach((p) => console.log("added", engine.addRoot(p))); break;
      case "index":   await engine.index((p) => console.log(`${p.done}/${p.total}`)); break;
      case "search":  console.table(await engine.search(args.join(" "))); break;
      case "similar": console.table(await engine.similar(args[0])); break;
      default:        console.log("usage: sf <add|index|search|similar> ...");
    }
  } finally {
    engine.close();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
