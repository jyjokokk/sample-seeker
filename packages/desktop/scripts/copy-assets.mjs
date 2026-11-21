// Copy non-TS renderer files (html, css, images) next to the compiled app.js.
import { cpSync, readdirSync } from "node:fs";

for (const f of readdirSync("renderer")) {
  if (!f.endsWith(".ts")) cpSync(`renderer/${f}`, `dist/renderer/${f}`);
}
