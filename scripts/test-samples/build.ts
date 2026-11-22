#!/usr/bin/env node
// S24: build the Sample Seeker test sample set inside the Ableton User Library.
//
//   node scripts/test-samples/build.ts [--user-library <path>] [--bulk <n>] [--force] [--update-manifest]
//   node scripts/test-samples/build.ts auth [<code>]
//
// varied/      CC0 Freesound sounds listed in manifest.json, downloaded with YOUR Freesound credentials
//              (see freesound.ts). Nothing is re-hosted: Freesound's API terms (§4(a)) forbid that.
//              CREDITS.md and samples.json (id, category, original name, author per file) go next to it.
// edge-cases/  generated with ffmpeg from synthetic tones and noise
// bulk/        optional (--bulk <n>): n copies of a few varied/ files, for indexing-speed tests
//
// Re-runs only download what is missing or changed, so a complete set needs no network or login.
// --update-manifest (maintainer): pin the sha256 of every downloaded sound that manifest.json doesn't pin yet.
// Needs ffmpeg. No audio ever goes into the repo.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
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
import {
  AuthError,
  authorizeUrl,
  CC0,
  downloadOriginal,
  exchangeCode,
  soundInfos,
} from "./freesound.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const MANIFEST = join(HERE, "manifest.json");
const AUDIO_EXT = new Set([".wav", ".aif", ".aiff", ".mp3", ".flac", ".ogg", ".m4a"]);

/** manifest.json (committed): only ids, categories and pinned sha256s, no Freesound metadata. */
interface Manifest {
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
  license: string;
  sha256: string;
}

type Index = Map<number, IndexEntry>;

interface Args {
  userLibrary: string;
  bulk: number;
  force: boolean;
  updateManifest: boolean;
}

// ---------- args ----------

function defaultUserLibrary(): string | null {
  if (process.platform === "darwin") return join(homedir(), "Music/Ableton/User Library");
  if (process.platform === "win32") return join(homedir(), "Documents/Ableton/User Library");
  return null;
}

const USAGE =
  "usage: build.ts [--user-library <path>] [--bulk <n>] [--force] [--update-manifest]\n" +
  "       build.ts auth [<code>]";

function parseArgs(argv: string[]): Args {
  const userLibrary = defaultUserLibrary();
  const args = { userLibrary, bulk: 0, force: false, updateManifest: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--user-library") args.userLibrary = argv[++i];
    else if (a === "--bulk") args.bulk = Number(argv[++i]);
    else if (a === "--force") args.force = true;
    else if (a === "--update-manifest") args.updateManifest = true;
    else if (a === "-h" || a === "--help") {
      console.log(USAGE);
      process.exit(0);
    } else throw new Error(`unknown argument: ${a}\n${USAGE}`);
  }
  if (!args.userLibrary)
    throw new Error("no default Ableton User Library on this platform: pass --user-library <path>");
  if (!Number.isInteger(args.bulk) || args.bulk < 0)
    throw new Error("--bulk must be a non-negative integer");
  return { ...args, userLibrary: args.userLibrary };
}

// ---------- helpers ----------

const sha256 = (path: string): string =>
  createHash("sha256").update(readFileSync(path)).digest("hex");
const hash = (s: string): Buffer => createHash("sha256").update(s).digest();

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
function sanitizeName(name: string, ext: string): string {
  // NFKD splits "ä" into "a" + a combining mark, which is then dropped.
  let base = name.normalize("NFKD").replace(/\p{M}/gu, "");
  if (AUDIO_EXT.has(extname(base).toLowerCase())) base = base.slice(0, -extname(base).length);
  base = base
    .replace(/\s+/g, " ")
    .replace(/[^\x20-\x7e]/g, "_")
    .replace(/[<>:"/\\|?*]/g, "_")
    .trim()
    .replace(/^[.\s]+|[.\s]+$/g, "")
    .slice(0, 100)
    .trim();
  if (base === "" || WINDOWS_RESERVED.test(base)) base = `freesound ${base}`.trim();
  return base + ext;
}

function targetName(id: number, name: string, ext: string): string {
  const h = hash(`badname:freesound:${id}`);
  if (h[0] / 256 >= BAD_NAME_SHARE) return sanitizeName(name, ext);
  return BAD_NAMES[h[1] % BAD_NAMES.length](1 + (((h[2] << 8) | h[3]) % 999)) + ext;
}

// A name that is taken (case-insensitively, for macOS and Windows) gets " 2", " 3", … before the extension.
function uniqueName(name: string, used: Set<string>): string {
  const ext = extname(name);
  const stem = name.slice(0, -ext.length);
  let candidate = name;
  for (let n = 2; used.has(candidate.toLowerCase()); n++) candidate = `${stem} ${n}${ext}`;
  used.add(candidate.toLowerCase());
  return candidate;
}

const EXT_BY_TYPE: Record<string, string | undefined> = {
  wav: ".wav",
  aif: ".aif",
  aiff: ".aif",
  flac: ".flac",
  mp3: ".mp3",
  ogg: ".ogg",
  m4a: ".m4a",
};

// ---------- varied/ ----------

// samples.json, next to varied/, records what was downloaded: it lets re-runs skip the network, and it is
// the local ground truth (id, category, original name) for the benchmark. Never committed: it holds
// Freesound metadata.
function readIndex(path: string): Index {
  if (!existsSync(path)) return new Map();
  const { samples } = JSON.parse(readFileSync(path, "utf8")) as { samples: IndexEntry[] };
  return new Map(samples.map((e) => [e.id, e]));
}

function writeIndex(path: string, index: Index): void {
  const samples = [...index.values()].sort((a, b) => a.id - b.id);
  writeFileSync(path, `${JSON.stringify({ samples }, null, 2)}\n`);
}

function writeCredits(path: string, index: Index): void {
  const rows = [...index.values()]
    .sort((a, b) => a.file.localeCompare(b.file))
    .map(
      (e) =>
        `| ${e.file} | [${e.id}](${e.url}) | ${e.name.replaceAll("|", "\\|")} | ${e.author} | CC0 1.0 |`,
    );
  writeFileSync(
    path,
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

async function buildVaried(manifest: Manifest, base: string, force: boolean) {
  const variedDir = join(base, "varied");
  mkdirSync(variedDir, { recursive: true });
  const indexPath = join(base, "samples.json");
  const index = readIndex(indexPath);
  const wanted = new Set(manifest.samples.map((s) => s.id));
  for (const id of index.keys()) if (!wanted.has(id)) index.delete(id);

  const stats = { downloaded: 0, unchanged: 0, rejected: 0 };
  const isDone = (s: ManifestSample): boolean => {
    const e = index.get(s.id);
    if (!e || !existsSync(join(variedDir, e.file))) return false;
    return sha256(join(variedDir, e.file)) === (s.sha256 ?? e.sha256);
  };
  const todo = manifest.samples.filter((s) => force || !isDone(s)).sort((a, b) => a.id - b.id);
  stats.unchanged = manifest.samples.length - todo.length;

  const todoIds = new Set(todo.map((s) => s.id));
  const used = new Set(
    [...index.values()].filter((e) => !todoIds.has(e.id)).map((e) => e.file.toLowerCase()),
  );

  if (todo.length > 0)
    console.log(`  downloading ${todo.length} sound(s) from Freesound (rate-limited, ~2 s each)…`);
  const started = Date.now();
  const width = String(todo.length).length;
  // "[ 12/149]", plus the estimated time left once a few sounds have been timed.
  const progress = (done: number) => {
    const counter = `[${String(done).padStart(width)}/${todo.length}]`;
    if (done < 3 || done === todo.length) return counter;
    const left = ((Date.now() - started) / done) * (todo.length - done);
    return `${counter} ~${Math.ceil(left / 60_000)} min left`;
  };
  // One search request for all metadata, so the daily request limit goes to downloads (see freesound.ts).
  const infos = await soundInfos(todo.map((s) => s.id)); // no request when nothing to do
  try {
    for (const [i, s] of todo.entries()) {
      const reject = (why: string) => {
        console.error(`  ${progress(i + 1)} rejected ${s.id} (${s.category}): ${why}`);
        stats.rejected++;
      };
      const info = infos.get(s.id);
      if (!info) {
        reject("no longer on Freesound (maintainer: replace it in manifest.json)");
        continue;
      }
      if (!CC0.test(String(info.license))) {
        reject(`no longer CC0 (${info.license}); maintainer: replace it in manifest.json`);
        continue;
      }
      const ext = EXT_BY_TYPE[String(info.type).toLowerCase()];
      if (!ext) {
        reject(`unsupported file type: ${info.type}`);
        continue;
      }
      const tmp = join(variedDir, `.${s.id}.download`);
      await downloadOriginal(s.id, tmp);
      const digest = sha256(tmp);
      if (s.sha256 && digest !== s.sha256) {
        rmSync(tmp, { force: true });
        reject("downloaded file doesn't match the sha256 in manifest.json");
        continue;
      }
      const old = index.get(s.id);
      if (old) used.delete(old.file.toLowerCase());
      const file = uniqueName(targetName(s.id, info.name, ext), used);
      if (old && old.file !== file) rmSync(join(variedDir, old.file), { force: true });
      renameSync(tmp, join(variedDir, file));
      index.set(s.id, {
        id: s.id,
        category: s.category,
        file,
        name: info.name,
        author: info.username,
        url: info.url,
        license: info.license,
        sha256: digest,
      });
      writeIndex(indexPath, index); // keep progress if the run is interrupted
      stats.downloaded++;
      const kb = Math.round(statSync(join(variedDir, file)).size / 1024);
      console.log(`  ${progress(i + 1)} ${s.category.padEnd(10)} ${file} (${kb} KB)`);
    }
  } finally {
    if (index.size > 0 || existsSync(indexPath)) writeIndex(indexPath, index);
    if (index.size > 0) writeCredits(join(base, "CREDITS.md"), index);
  }

  // Files on disk that the manifest doesn't list. Left alone: they may be the user's.
  const known = new Set([...index.values()].map((e) => e.file));
  for (const name of readdirSync(variedDir).sort()) {
    // Only audio: Live adds an .asd analysis file next to every sample it has previewed.
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

// Each case: output name + ffmpeg args (after the input). Inputs are synthetic, so no licensing questions.
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

const EDGE_CASES: { name: string; input: string[]; out: string[] }[] = [
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
];

function buildEdgeCases(outDir: string, force: boolean): number {
  mkdirSync(outDir, { recursive: true });
  let made = 0;
  for (const c of EDGE_CASES) {
    const dest = join(outDir, c.name);
    if (existsSync(dest) && !force) continue;
    // Strip metadata (encoder version tags) so output is stable across ffmpeg versions where possible.
    ffmpeg([...c.input, "-map_metadata", "-1", "-fflags", "+bitexact", ...c.out, dest]);
    made++;
  }

  // corrupt.wav: a RIFF/WAVE header followed by garbage instead of fmt/data chunks.
  const corrupt = Buffer.concat([
    Buffer.from("RIFF"),
    Buffer.from([0x24, 0x10, 0, 0]),
    Buffer.from("WAVE"),
    garbage(4096),
  ]);
  const files: [string, Buffer][] = [
    ["corrupt.wav", corrupt],
    ["empty.wav", Buffer.alloc(0)],
  ];
  for (const [name, bytes] of files) {
    const dest = join(outDir, name);
    if (existsSync(dest) && !force) continue;
    writeFileSync(dest, bytes);
    made++;
  }
  return made;
}

// ---------- bulk/ ----------

function buildBulk(variedDir: string, outDir: string, n: number): number {
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  const seeds = readdirSync(variedDir)
    .filter((f) => AUDIO_EXT.has(extname(f).toLowerCase()))
    .sort()
    .slice(0, 10);
  if (seeds.length === 0) throw new Error("bulk/ needs files in varied/ first");
  for (let i = 0; i < n; i++) {
    const src = seeds[i % seeds.length];
    copyFileSync(join(variedDir, src), join(outDir, `${String(i).padStart(4, "0")} ${src}`));
  }
  return n;
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
  const argv = process.argv.slice(2);
  if (argv[0] === "auth") return auth(argv[1]);

  const args = parseArgs(argv);
  if (!existsSync(args.userLibrary))
    throw new Error(`User Library not found: ${args.userLibrary} (use --user-library)`);

  const manifest = JSON.parse(readFileSync(MANIFEST, "utf8")) as Manifest;
  const base = join(args.userLibrary, manifest.folder);
  console.log(`Test folder: ${base}`);

  console.log("edge-cases/");
  const made = buildEdgeCases(join(base, "edge-cases"), args.force);
  console.log(`  ${made} written, ${EDGE_CASES.length + 2 - made} already there`);

  console.log("varied/");
  const { stats, index } = await buildVaried(manifest, base, args.force);
  console.log(
    `  ${stats.downloaded} downloaded, ${stats.unchanged} unchanged, ${stats.rejected} rejected`,
  );
  const counts: Record<string, number> = {};
  for (const s of manifest.samples) counts[s.category] = (counts[s.category] ?? 0) + 1;
  for (const [cat, n] of Object.entries(counts).sort()) console.log(`    ${cat.padEnd(12)} ${n}`);

  const unpinned = manifest.samples.filter((s) => !s.sha256).length;
  if (args.updateManifest)
    console.log(`  pinned ${updateManifest(manifest, index)} sha256(s) in manifest.json`);
  else if (unpinned > 0)
    console.warn(
      `  ${unpinned} sound(s) have no sha256 in manifest.json yet (maintainer: --update-manifest)`,
    );

  if (args.bulk > 0) {
    console.log("bulk/");
    console.log(`  ${buildBulk(join(base, "varied"), join(base, "bulk"), args.bulk)} copies`);
  }

  if (stats.rejected > 0) process.exitCode = 1;
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(err instanceof AuthError ? `\n${message}` : message);
  process.exit(1);
});
