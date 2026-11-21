#!/usr/bin/env node
/**
 * Dev CLI, for testing the engine without the app.
 *   sample-seeker add <folder> | remove <folder> | index | search "<query>" | similar <file>
 * From the repo root: pnpm sample-seeker <command> ...
 */
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { Engine } from "./engine";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { db: { type: "string", default: join(homedir(), ".sample-seeker", "index.db") } },
});
const [cmd, ...args] = positionals;

async function main() {
  const engine = await Engine.open({ dbPath: values.db! });
  try {
    switch (cmd) {
      case "add":
        for (const p of args) console.log("added", engine.addRoot(p));
        break;
      case "remove":
        for (const p of args) {
          const abs = resolve(p);
          console.log(engine.removeRoot(abs) ? "removed" : "not a root:", abs);
        }
        break;
      case "index":
        await engine.index((p) => console.log(`${p.done}/${p.total}`));
        break;
      case "search":
        console.table(await engine.search(args.join(" ")));
        break;
      case "similar":
        console.table(await engine.similar(args[0]));
        break;
      default:
        console.log("usage: sample-seeker <add|remove|index|search|similar> ...");
    }
  } finally {
    engine.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
