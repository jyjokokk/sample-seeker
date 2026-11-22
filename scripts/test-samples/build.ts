#!/usr/bin/env node
// S24: build the Sample Seeker test sample set (varied/, edge-cases/, bulk/) inside the Ableton User Library.
// Usage, setup and the reasons behind it: scripts/test-samples/README.md.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  AuthError,
  authorizeUrl,
  downloadOriginal,
  exchangeCode,
  soundInfos,
} from "./freesound.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const MANIFEST = join(HERE, "manifest.json");
const CC0 = /^https?:\/\/creativecommons\.org\/publicdomain\/zero\/1\.0\/?$/;

// Freesound file type → extension. Also the list of audio extensions this script recognises.
const EXT_BY_TYPE: Record<string, string | undefined> = {
  wav: ".wav",
  aif: ".aif",
  aiff: ".aif",
  flac: ".flac",
  mp3: ".mp3",
  ogg: ".ogg",
  m4a: ".m4a",
};
const AUDIO_EXT = new Set([...Object.values(EXT_BY_TYPE), ".aiff"]);

/** manifest.json (committed): only ids, categories and pinned sha256s, no Freesound metadata. */
export interface Manifest {
  folder: string;
  samples: ManifestSample[];
}

interface ManifestSample {
  id: number;
  category: string;
  sha256?: string;
}

/** One entry of samples.json (local only, next to varied/). */
interface IndexEntry {
  id: number;
  category: string;
  file: string;
  name: string;
  author: string;
  url: string;
  sha256: string;
}

type Index = Map<number, IndexEntry>;

// ---------- args ----------

const USAGE =
  "usage: build.ts [--user-library <path>] [--bulk <n>] [--force] [--update-manifest]\n" +
  "       build.ts auth [<code>]";

function defaultUserLibrary(): string | undefined {
  if (process.platform === "darwin") return join(homedir(), "Music/Ableton/User Library");
  if (process.platform === "win32") return join(homedir(), "Documents/Ableton/User Library");
}

function cliArgs() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      "user-library": { type: "string", default: defaultUserLibrary() },
      bulk: { type: "string", default: "0" },
      force: { type: "boolean", default: false },
      "update-manifest": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  const bulk = Number(values.bulk);
  if (!Number.isInteger(bulk) || bulk < 0) throw new Error("--bulk must be a non-negative integer");
  return { ...values, bulk, positionals };
}

// ---------- helpers ----------

const sha256 = (path: string): string =>
  createHash("sha256").update(readFileSync(path)).digest("hex");

function ffmpeg(args: string[]): void {
  const bin = process.env.FFMPEG ?? "ffmpeg";
  const r = spawnSync(bin, ["-v", "error", "-nostdin", "-y", ...args], { encoding: "utf8" });
  if (r.error)
    throw new Error(`could not run ${bin}: ${r.error.message} (install ffmpeg or set FFMPEG)`);
  if (r.status !== 0) throw new Error(`ffmpeg failed: ${r.stderr.trim()}`);
}

// Deterministic pseudo-random bytes, so the corrupt file is the same on every run.
function garbage(n: number): Buffer {
  const out = Buffer.alloc(n);
  let block = Buffer.from("sample-seeker-s24");
  for (let i = 0; i < n; i += 32) {
    block = createHash("sha256").update(block).digest();
    block.copy(out, i, 0, Math.min(32, n - i));
  }
  return out;
}

// ---------- file names ----------

// ~35 % of the sounds get a bad generic name, to test search on badly named files. Whether a sound gets one,
// and which, depends only on its Freesound id, so the names are the same on every machine.
const BAD_NAME_SHARE = 0.35;
const BAD_NAMES: ((n: number) => string)[] = [
  (n) => `Audio ${String(n).padStart(4, "0")}`,
  (n) => `smpl_${n}`,
  (n) => `bounce final${n % 7 || ""}`,
  (n) => `untitled ${n}`,
  (n) => `rec_2019031${n % 10}_${String(n).padStart(2, "0")}`,
  (n) => `New Recording ${n}`,
  (n) => `Track ${String(n).padStart(2, "0")}`,
  (n) => `sample (${n})`,
  (n) => `xx_${n}_FINAL`,
  (n) => `${String(n).padStart(4, "0")}`,
];

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)$/i;

// A file-system-safe version of the Freesound name: ASCII only, no characters Windows rejects, and without
// the extension Freesound names often carry.
export function sanitizeName(name: string, ext: string): string {
  // NFKD splits "ä" into "a" + a combining mark, which is then dropped.
  let base = name.normalize("NFKD").replace(/\p{M}/gu, "");
  if (AUDIO_EXT.has(extname(base).toLowerCase())) base = base.slice(0, -extname(base).length);
  base = base
    .replace(/\s+/g, " ")
    .replace(/[^\x20-\x7e]/g, "_")
    .replace(/[<>:"/\\|?*]/g, "_")
    .replace(/^[.\s]+|[.\s]+$/g, "")
    .slice(0, 100)
    .trim();
  if (base === "" || WINDOWS_RESERVED.test(base)) base = `freesound ${base}`.trim();
  return base + ext;
}

export function targetName(id: number, name: string, ext: string): string {
  const h = createHash("sha256").update(`badname:freesound:${id}`).digest();
  if (h[0] / 256 >= BAD_NAME_SHARE) return sanitizeName(name, ext);
  return BAD_NAMES[h[1] % BAD_NAMES.length](1 + (((h[2] << 8) | h[3]) % 999)) + ext;
}

// A name that is taken (case-insensitively, for macOS and Windows) gets " 2", " 3", … before the extension.
export function uniqueName(name: string, used: Set<string>): string {
  const ext = extname(name);
  const stem = name.slice(0, -ext.length);
  let candidate = name;
  for (let n = 2; used.has(candidate.toLowerCase()); n++) candidate = `${stem} ${n}${ext}`;
  used.add(candidate.toLowerCase());
  return candidate;
}

// ---------- varied/ ----------

// samples.json, next to varied/, records what was downloaded: it lets re-runs skip the network, and it is
// the local ground truth (id, category, original name) for the benchmark. Never committed: it holds
// Freesound metadata. CREDITS.md is generated from it.
function readIndex(path: string): Index {
  if (!existsSync(path)) return new Map();
  const { samples } = JSON.parse(readFileSync(path, "utf8")) as { samples: IndexEntry[] };
  return new Map(samples.map((e) => [e.id, e]));
}

function saveIndex(base: string, index: Index): void {
  const samples = [...index.values()].sort((a, b) => a.id - b.id);
  writeFileSync(join(base, "samples.json"), `${JSON.stringify({ samples }, null, 2)}\n`);
  const rows = samples
    .sort((a, b) => a.file.localeCompare(b.file))
    .map(
      (e) =>
        `| ${e.file} | [${e.id}](${e.url}) | ${e.name.replaceAll("|", "\\|")} | ${e.author} | CC0 1.0 |`,
    );
  writeFileSync(
    join(base, "CREDITS.md"),
    [
      "# Credits",
      "",
      "Sounds from [Freesound](https://freesound.org), all under",
      "[CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/) (no attribution required; credited anyway).",
      "Downloaded with your own Freesound account by `pnpm test-samples`; not for redistribution as a set.",
      "",
      "| File | Freesound | Original name | Author | License |",
      "| --- | --- | --- | --- | --- |",
      ...rows,
      "",
    ].join("\n"),
  );
}

export async function buildVaried(manifest: Manifest, base: string, force: boolean) {
  const variedDir = join(base, "varied");
  mkdirSync(variedDir, { recursive: true });
  const index = readIndex(join(base, "samples.json"));
  const wanted = new Set(manifest.samples.map((s) => s.id));
  const stale = [...index.keys()].filter((id) => !wanted.has(id));
  for (const id of stale) index.delete(id);
  if (stale.length > 0) saveIndex(base, index);

  const isDone = (s: ManifestSample): boolean => {
    const e = index.get(s.id);
    if (!e || !existsSync(join(variedDir, e.file))) return false;
    return sha256(join(variedDir, e.file)) === (s.sha256 ?? e.sha256);
  };
  const todo = manifest.samples.filter((s) => force || !isDone(s)).sort((a, b) => a.id - b.id);
  const stats = { downloaded: 0, unchanged: manifest.samples.length - todo.length, rejected: 0 };
  if (todo.length > 0)
    console.log(`  downloading ${todo.length} sound(s) from Freesound (rate-limited, ~2 s each)…`);

  // One search request for all metadata, then every file name decided up front, in id order, so the
  // download loop never has to resolve name clashes.
  const infos = await soundInfos(todo.map((s) => s.id));
  const todoIds = new Set(todo.map((s) => s.id));
  const used = new Set(
    [...index.values()].filter((e) => !todoIds.has(e.id)).map((e) => e.file.toLowerCase()),
  );
  const plan = todo.map((s) => {
    const info = infos.get(s.id);
    if (!info)
      return { s, problem: "no longer on Freesound (maintainer: replace it in manifest.json)" };
    if (!CC0.test(info.license))
      return {
        s,
        problem: `no longer CC0 (${info.license}); maintainer: replace it in manifest.json`,
      };
    const ext = EXT_BY_TYPE[info.type.toLowerCase()];
    if (!ext) return { s, problem: `unsupported file type: ${info.type}` };
    return { s, info, file: uniqueName(targetName(s.id, info.name, ext), used) };
  });

  const started = Date.now();
  const width = String(todo.length).length;
  // "[ 12/149]", plus the estimated time left once a few sounds have been timed.
  const progress = (done: number) => {
    const counter = `[${String(done).padStart(width)}/${todo.length}]`;
    if (done < 3 || done === todo.length) return counter;
    const left = ((Date.now() - started) / done) * (todo.length - done);
    return `${counter} ~${Math.ceil(left / 60_000)} min left`;
  };

  for (const [i, entry] of plan.entries()) {
    const { s } = entry;
    const reject = (why: string) => {
      console.error(`  ${progress(i + 1)} rejected ${s.id} (${s.category}): ${why}`);
      stats.rejected++;
    };
    if (entry.problem !== undefined) {
      reject(entry.problem);
      continue;
    }
    const { info, file } = entry;
    const tmp = join(variedDir, `.${s.id}.download`);
    let digest: string;
    try {
      digest = await downloadOriginal(s.id, tmp);
      if (s.sha256 && digest !== s.sha256) {
        reject("doesn't match the sha256 in manifest.json");
        continue;
      }
      // A renamed sound's old file goes, unless another sound has taken that name in the meantime.
      const old = index.get(s.id);
      const oldTaken = [...index.values()].some((e) => e.id !== s.id && e.file === old?.file);
      if (old && old.file !== file && !oldTaken) rmSync(join(variedDir, old.file), { force: true });
      renameSync(tmp, join(variedDir, file));
    } finally {
      rmSync(tmp, { force: true }); // nothing left after the rename; a failed or rejected download otherwise
    }
    index.set(s.id, {
      id: s.id,
      category: s.category,
      file,
      name: info.name,
      author: info.username,
      url: info.url,
      sha256: digest,
    });
    saveIndex(base, index); // keep progress if the run is interrupted
    stats.downloaded++;
    const kb = Math.round(statSync(join(variedDir, file)).size / 1024);
    console.log(`  ${progress(i + 1)} ${s.category.padEnd(10)} ${file} (${kb} KB)`);
  }

  // Audio files that the manifest doesn't list are left alone: they may be the user's. (Not .asd files:
  // Live adds one next to every sample it has previewed.)
  const known = new Set([...index.values()].map((e) => e.file));
  for (const name of readdirSync(variedDir).sort()) {
    if (!known.has(name) && !name.startsWith(".") && AUDIO_EXT.has(extname(name).toLowerCase()))
      console.warn(`  not in manifest (remove by hand if stale): varied/${name}`);
  }
  return { stats, index };
}

function updateManifest(manifest: Manifest, index: Index): number {
  let pinned = 0;
  for (const s of manifest.samples) {
    const e = index.get(s.id);
    if (!s.sha256 && e) {
      s.sha256 = e.sha256;
      pinned++;
    }
  }
  writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);
  return pinned;
}

// ---------- edge-cases/ ----------

// Generated from synthetic tones and noise, so there are no licensing questions.
const TONE = (seconds: number, channels: 1 | 2): string[] => [
  "-f",
  "lavfi",
  "-i",
  `sine=frequency=220:sample_rate=48000:duration=${seconds}`,
  "-f",
  "lavfi",
  "-i",
  `sine=frequency=330:sample_rate=48000:duration=${seconds}`,
  "-filter_complex",
  channels === 2 ? "[0][1]join=inputs=2:channel_layout=stereo" : "[0][1]amix=inputs=2",
];

// Each case is made either by ffmpeg (input args + output args) or from fixed bytes.
type EdgeCase = { name: string } & ({ input: string[]; out: string[] } | { bytes: () => Buffer });

const EDGE_CASES: EdgeCase[] = [
  {
    name: "wav-16bit-stereo-44k.wav",
    input: TONE(3, 2),
    out: ["-ar", "44100", "-c:a", "pcm_s16le"],
  },
  { name: "wav-24bit-mono-48k.wav", input: TONE(3, 1), out: ["-ar", "48000", "-c:a", "pcm_s24le"] },
  {
    name: "wav-32float-stereo-96k.wav",
    input: TONE(3, 2),
    out: ["-ar", "96000", "-c:a", "pcm_f32le"],
  },
  {
    name: "aiff-16bit-stereo-44k.aif",
    input: TONE(3, 2),
    out: ["-ar", "44100", "-c:a", "pcm_s16be", "-f", "aiff"],
  },
  {
    name: "mp3-stereo-44k.mp3",
    input: TONE(3, 2),
    out: ["-ar", "44100", "-c:a", "libmp3lame", "-b:a", "192k"],
  },
  {
    name: "flac-24bit-mono-48k.flac",
    input: TONE(3, 1),
    out: ["-ar", "48000", "-c:a", "flac", "-sample_fmt", "s32"],
  },
  {
    name: "long-45s-stereo.wav",
    input: [
      "-f",
      "lavfi",
      "-i",
      "anoisesrc=color=pink:amplitude=0.2:sample_rate=44100:duration=45:seed=24",
      "-ac",
      "2",
    ],
    out: ["-c:a", "pcm_s16le"],
  },
  // A RIFF/WAVE header followed by garbage instead of fmt/data chunks.
  {
    name: "corrupt.wav",
    bytes: () =>
      Buffer.concat([
        Buffer.from("RIFF"),
        Buffer.from([0x24, 0x10, 0, 0]),
        Buffer.from("WAVE"),
        garbage(4096),
      ]),
  },
  { name: "empty.wav", bytes: () => Buffer.alloc(0) },
];

export function buildEdgeCases(outDir: string, force: boolean): number {
  mkdirSync(outDir, { recursive: true });
  let made = 0;
  for (const c of EDGE_CASES) {
    const dest = join(outDir, c.name);
    if (existsSync(dest) && !force) continue;
    if ("bytes" in c) writeFileSync(dest, c.bytes());
    // Strip metadata (encoder version tags) so output is stable across ffmpeg versions where possible.
    else ffmpeg([...c.input, "-map_metadata", "-1", "-fflags", "+bitexact", ...c.out, dest]);
    made++;
  }
  return made;
}

// ---------- bulk/ ----------

// n copies of the first 10 varied/ sounds. Existing copies are kept; new ones are clones where the file
// system supports it (APFS), so they cost next to no time or space.
export function buildBulk(variedDir: string, outDir: string, index: Index, n: number): void {
  const seeds = [...index.values()]
    .map((e) => e.file)
    .sort()
    .slice(0, 10);
  if (seeds.length === 0) throw new Error("bulk/ needs files in varied/ first");
  mkdirSync(outDir, { recursive: true });
  const wanted = new Set<string>();
  for (let i = 0; i < n; i++) {
    const seed = seeds[i % seeds.length];
    const src = join(variedDir, seed);
    const name = `${String(i).padStart(4, "0")} ${seed}`;
    wanted.add(name);
    const dest = join(outDir, name);
    if (existsSync(dest) && statSync(dest).size === statSync(src).size) continue;
    copyFileSync(src, dest, constants.COPYFILE_FICLONE);
  }
  for (const name of readdirSync(outDir)) if (!wanted.has(name)) rmSync(join(outDir, name));
}

// ---------- main ----------

async function auth(code: string | undefined): Promise<void> {
  if (!code) {
    console.log(
      [
        "1. Open this link, log in to Freesound and authorize the app:",
        `   ${authorizeUrl()}`,
        "2. Copy the code Freesound shows (it expires after ~10 minutes) and run:",
        "   pnpm test-samples auth <code>",
      ].join("\n"),
    );
    return;
  }
  await exchangeCode(code);
  console.log("Logged in to Freesound. The token is saved and refreshed automatically.");
}

async function main(): Promise<void> {
  const args = cliArgs();
  if (args.help) return console.log(USAGE);
  if (args.positionals[0] === "auth") return auth(args.positionals[1]);
  if (args.positionals.length > 0)
    throw new Error(`unknown command: ${args.positionals[0]}\n${USAGE}`);

  const userLibrary = args["user-library"];
  if (!userLibrary)
    throw new Error("no default Ableton User Library on this platform: pass --user-library <path>");
  if (!existsSync(userLibrary))
    throw new Error(`User Library not found: ${userLibrary} (use --user-library)`);

  const manifest = JSON.parse(readFileSync(MANIFEST, "utf8")) as Manifest;
  const base = join(userLibrary, manifest.folder);
  console.log(`Test folder: ${base}`);

  console.log("edge-cases/");
  const made = buildEdgeCases(join(base, "edge-cases"), args.force);
  console.log(`  ${made} written, ${EDGE_CASES.length - made} already there`);

  console.log("varied/");
  const { stats, index } = await buildVaried(manifest, base, args.force);
  console.log(
    `  ${stats.downloaded} downloaded, ${stats.unchanged} unchanged, ${stats.rejected} rejected`,
  );
  const counts: Record<string, number> = {};
  for (const s of manifest.samples) counts[s.category] = (counts[s.category] ?? 0) + 1;
  for (const [cat, n] of Object.entries(counts).sort()) console.log(`    ${cat.padEnd(12)} ${n}`);

  if (args["update-manifest"])
    console.log(`  pinned ${updateManifest(manifest, index)} sha256(s) in manifest.json`);
  else {
    const unpinned = manifest.samples.filter((s) => !s.sha256).length;
    if (unpinned > 0)
      console.warn(
        `  ${unpinned} sound(s) have no sha256 in manifest.json yet (maintainer: --update-manifest)`,
      );
  }

  if (args.bulk > 0) {
    buildBulk(join(base, "varied"), join(base, "bulk"), index, args.bulk);
    console.log(`bulk/\n  ${args.bulk} copies`);
  }

  if (stats.rejected > 0) process.exitCode = 1;
}

// Only when run as a script, so the tests can import the functions above.
if (import.meta.main)
  main().catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    if (err instanceof AuthError)
      console.error(`\n${message}. Run \`pnpm test-samples auth\` to log in to Freesound.`);
    else console.error(message);
    process.exit(1);
  });
