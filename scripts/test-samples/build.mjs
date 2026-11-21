#!/usr/bin/env node
// S24: build the Sample Seeker test sample set inside the Ableton User Library.
//
//   node scripts/test-samples/build.mjs [--user-library <path>] [--zip <path>] [--bulk <n>] [--force]
//
// varied/      CC0 Freesound sounds from the release zip that manifest.json points to (CREDITS.md next to it)
// edge-cases/  generated with ffmpeg from synthetic tones and noise
// bulk/        optional (--bulk <n>): n copies of a few varied/ files, for indexing-speed tests
//
// The zip is downloaded once to <repo>/.cache/test-samples/ and checked against the sha256 in manifest.json.
// --zip <path> uses a local zip instead (before a release exists, or to test a new one).
// Needs ffmpeg, and `unzip` or a `tar` that reads zips (bsdtar: macOS, Windows 10+).
// No audio ever goes into the repo.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  createWriteStream,
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
import { basename, dirname, extname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../..");
const CACHE = join(REPO, ".cache/test-samples");
const AUDIO_EXT = new Set([".wav", ".aif", ".aiff", ".mp3", ".flac", ".ogg", ".m4a"]);

// ---------- args ----------

function defaultUserLibrary() {
  if (process.platform === "darwin") return join(homedir(), "Music/Ableton/User Library");
  if (process.platform === "win32") return join(homedir(), "Documents/Ableton/User Library");
  return null;
}

function parseArgs(argv) {
  const args = { userLibrary: defaultUserLibrary(), zip: null, bulk: 0, force: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--user-library") args.userLibrary = argv[++i];
    else if (a === "--zip") args.zip = resolve(argv[++i]);
    else if (a === "--bulk") args.bulk = Number(argv[++i]);
    else if (a === "--force") args.force = true;
    else if (a === "-h" || a === "--help") {
      console.log("usage: build.mjs [--user-library <path>] [--zip <path>] [--bulk <n>] [--force]");
      process.exit(0);
    } else throw new Error(`unknown argument: ${a}`);
  }
  if (!args.userLibrary)
    throw new Error("no default Ableton User Library on this platform: pass --user-library <path>");
  if (!Number.isInteger(args.bulk) || args.bulk < 0)
    throw new Error("--bulk must be a non-negative integer");
  return args;
}

// ---------- helpers ----------

const sha256 = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");

function ffmpeg(args) {
  const bin = process.env.FFMPEG ?? "ffmpeg";
  const r = spawnSync(bin, ["-v", "error", "-nostdin", "-y", ...args], { encoding: "utf8" });
  if (r.error)
    throw new Error(`could not run ${bin}: ${r.error.message} (install ffmpeg or set FFMPEG)`);
  if (r.status !== 0) throw new Error(`ffmpeg failed: ${r.stderr.trim()}`);
}

// Deterministic pseudo-random bytes, so the corrupt file is the same on every run.
function garbage(n) {
  const out = Buffer.alloc(n);
  let block = Buffer.from("sample-seeker-s24");
  for (let i = 0; i < n; i += 32) {
    block = createHash("sha256").update(block).digest();
    block.copy(out, i, 0, Math.min(32, n - i));
  }
  return out;
}

// ---------- release zip ----------

const matchesRelease = (path, release) =>
  existsSync(path) && statSync(path).size === release.bytes && sha256(path) === release.sha256;

async function download(url, dest) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status} for ${url}`);
  const part = `${dest}.part`;
  await pipeline(Readable.fromWeb(res.body), createWriteStream(part));
  renameSync(part, dest);
}

// Returns the path of a zip that matches manifest.release (or the --zip path as given).
async function getZip(manifest, zipArg) {
  const { release } = manifest;
  if (zipArg) {
    if (!existsSync(zipArg)) throw new Error(`zip not found: ${zipArg}`);
    if (release && !matchesRelease(zipArg, release))
      console.warn(
        `  WARNING: ${basename(zipArg)} is not release v${release.version} from manifest.json; ` +
          "files that don't match the manifest will be rejected",
      );
    console.log(`  using ${zipArg}`);
    return zipArg;
  }
  const cached = join(CACHE, basename(new URL(release.url).pathname));
  if (matchesRelease(cached, release)) {
    console.log(`  cached: ${cached}`);
    return cached;
  }
  mkdirSync(CACHE, { recursive: true });
  console.log(`  downloading v${release.version} (${(release.bytes / 1e6).toFixed(1)} MB)…`);
  await download(release.url, cached);
  if (!matchesRelease(cached, release)) {
    rmSync(cached, { force: true });
    throw new Error(
      `downloaded zip doesn't match manifest.json (size ${release.bytes}, sha256 ${release.sha256})`,
    );
  }
  return cached;
}

function extract(zip, dir) {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const tools = [
    ["unzip", ["-q", "-o", zip, "-d", dir]],
    ["tar", ["-xf", zip, "-C", dir]],
  ];
  for (const [cmd, args] of tools) {
    const r = spawnSync(cmd, args, { encoding: "utf8" });
    if (r.error?.code === "ENOENT") continue;
    if (r.error || r.status !== 0)
      throw new Error(`${cmd} failed: ${r.error?.message ?? r.stderr.trim()}`);
    return;
  }
  throw new Error("need `unzip` or a `tar` that can read zip files (bsdtar) to extract the zip");
}

// ---------- varied/ ----------

async function buildVaried(manifest, base, zipArg, force) {
  if (!manifest.release && !zipArg)
    throw new Error(
      "manifest.json has no release yet: a maintainer has to pack and publish one first " +
        "(see scripts/test-samples/README.md), or pass --zip <path> to use a local zip",
    );
  const variedDir = join(base, "varied");
  mkdirSync(variedDir, { recursive: true });
  const stats = { written: 0, unchanged: 0, rejected: 0 };
  const credits = join(base, "CREDITS.md");

  const todo = manifest.samples.filter(
    (s) => force || !existsSync(join(base, s.file)) || sha256(join(base, s.file)) !== s.sha256,
  );
  stats.unchanged = manifest.samples.length - todo.length;

  if (todo.length > 0 || !existsSync(credits)) {
    const zip = await getZip(manifest, zipArg);
    const tmp = join(CACHE, "extract.tmp");
    mkdirSync(CACHE, { recursive: true });
    extract(zip, tmp);
    for (const s of todo) {
      const src = join(tmp, s.file);
      if (!existsSync(src)) {
        console.error(`  missing from zip: ${s.file}`);
        stats.rejected++;
      } else if (sha256(src) !== s.sha256) {
        console.error(`  sha256 mismatch, not copied: ${s.file}`);
        stats.rejected++;
      } else {
        copyFileSync(src, join(base, s.file));
        stats.written++;
      }
    }
    if (existsSync(join(tmp, "CREDITS.md"))) copyFileSync(join(tmp, "CREDITS.md"), credits);
    else console.warn("  zip has no CREDITS.md");
    rmSync(tmp, { recursive: true, force: true });
  }

  // Files on disk that the manifest doesn't list. Left alone: they may be the user's.
  const known = new Set(manifest.samples.map((s) => basename(s.file)));
  for (const name of readdirSync(variedDir).sort()) {
    if (!known.has(name) && !name.startsWith("."))
      console.warn(`  not in manifest (remove by hand if stale): varied/${name}`);
  }
  return stats;
}

// ---------- edge-cases/ ----------

// Each case: output name + ffmpeg args (after the input). Inputs are synthetic, so no licensing questions.
const TONE = (seconds, channels) => [
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

const EDGE_CASES = [
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

function buildEdgeCases(outDir, force) {
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
  for (const [name, bytes] of [
    ["corrupt.wav", corrupt],
    ["empty.wav", Buffer.alloc(0)],
  ]) {
    const dest = join(outDir, name);
    if (existsSync(dest) && !force) continue;
    writeFileSync(dest, bytes);
    made++;
  }
  return made;
}

// ---------- bulk/ ----------

function buildBulk(variedDir, outDir, n) {
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

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!existsSync(args.userLibrary))
    throw new Error(`User Library not found: ${args.userLibrary} (use --user-library)`);

  const manifest = JSON.parse(readFileSync(join(HERE, "manifest.json"), "utf8"));
  const base = join(args.userLibrary, manifest.folder);
  console.log(`Test folder: ${base}`);

  console.log("edge-cases/");
  const made = buildEdgeCases(join(base, "edge-cases"), args.force);
  console.log(`  ${made} written, ${EDGE_CASES.length + 2 - made} already there`);

  console.log("varied/");
  const stats = await buildVaried(manifest, base, args.zip, args.force);
  console.log(
    `  ${stats.written} written, ${stats.unchanged} unchanged, ${stats.rejected} rejected` +
      (manifest.release ? ` (release v${manifest.release.version})` : ""),
  );
  const counts = {};
  for (const s of manifest.samples) counts[s.category] = (counts[s.category] ?? 0) + 1;
  for (const [cat, n] of Object.entries(counts).sort()) console.log(`    ${cat.padEnd(12)} ${n}`);

  if (args.bulk > 0) {
    console.log("bulk/");
    console.log(`  ${buildBulk(join(base, "varied"), join(base, "bulk"), args.bulk)} copies`);
  }

  if (stats.rejected > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
