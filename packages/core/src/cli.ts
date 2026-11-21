#!/usr/bin/env node
/**
 * Dev CLI, for testing the engine without the app.
 *   sf add <folder> | sf remove <folder> | sf index | sf search "<query>" | sf similar <file>
 *
 * TODO: Rename the `sf` command. Its meaning is undocumented (probably "sample finder",
 * a pre-"Sample Seeker" name). Update the script key in the root package.json and the
 * usage strings in this file together.
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
        console.log("usage: sf <add|remove|index|search|similar> ...");
    }
  } finally {
    engine.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
