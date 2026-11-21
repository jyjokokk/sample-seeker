#!/usr/bin/env node
// S24: build the Sample Seeker test sample set inside the Ableton User Library.
//
//   node scripts/test-samples/build.mjs [--user-library <path>] [--bulk <n>] [--force]
//
// varied/      copied from Ableton content / downloaded from Freesound (CC0), as listed in manifest.json
// edge-cases/  generated with ffmpeg from synthetic tones and noise
// bulk/        optional (--bulk <n>): n copies of a few varied/ files, for indexing-speed tests
//
// No audio ever goes into the repo: Ableton content may not be redistributed (EULA §5(3)).

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const AUDIO_EXT = new Set([".wav", ".aif", ".aiff", ".mp3", ".flac", ".ogg", ".m4a"]);
const CC0 = "creativecommons.org/publicdomain/zero/1.0";

// ---------- args ----------

function parseArgs(argv) {
  const args = {
    userLibrary: join(homedir(), "Music/Ableton/User Library"),
    bulk: 0,
    force: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--user-library") args.userLibrary = argv[++i];
    else if (a === "--bulk") args.bulk = Number(argv[++i]);
    else if (a === "--force") args.force = true;
    else if (a === "-h" || a === "--help") {
      console.log("usage: build.mjs [--user-library <path>] [--bulk <n>] [--force]");
      process.exit(0);
    } else throw new Error(`unknown argument: ${a}`);
  }
  if (!Number.isInteger(args.bulk) || args.bulk < 0)
    throw new Error("--bulk must be a non-negative integer");
  return args;
}

// ---------- source roots ----------

function findCoreLibrary() {
  if (!existsSync("/Applications")) return null;
  const apps = readdirSync("/Applications")
    .filter((n) => /^Ableton Live .*\.app$/.test(n))
    .sort()
    .reverse();
  for (const app of apps) {
    const p = join("/Applications", app, "Contents/App-Resources/Core Library");
    if (existsSync(p)) return p;
  }
  return null;
}

function sourceRoot(entry, roots) {
  if (entry.source === "core") return roots.core;
  if (entry.source.startsWith("pack:"))
    return join(roots.packs, entry.source.slice("pack:".length));
  return null;
}

// ---------- helpers ----------

const sha256 = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");

function sameFile(a, b) {
  return existsSync(b) && statSync(a).size === statSync(b).size && sha256(a) === sha256(b);
}

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

// ---------- varied/ ----------

async function buildVaried(manifest, roots, outDir, force) {
  mkdirSync(outDir, { recursive: true });
  const stats = { copied: 0, skipped: 0, missing: 0 };
  const targets = new Set();
  const counts = {};

  for (const entry of manifest.varied) {
    if (targets.has(entry.target)) throw new Error(`duplicate target in manifest: ${entry.target}`);
    targets.add(entry.target);
    counts[entry.category] = (counts[entry.category] ?? 0) + 1;
    const dest = join(outDir, entry.target);

    if (entry.source === "freesound") {
      if (existsSync(dest) && !force) {
        stats.skipped++;
        continue;
      }
      const result = await downloadFreesound(entry, dest);
      stats[result === "ok" ? "copied" : result === "nokey" ? "skipped" : "missing"]++;
      continue;
    }

    const root = sourceRoot(entry, roots);
    const src = root && join(root, entry.path);
    if (!src || !existsSync(src)) {
      console.warn(`  missing source (${entry.source}): ${entry.path}`);
      stats.missing++;
      continue;
    }
    if (!force && sameFile(src, dest)) {
      stats.skipped++;
      continue;
    }
    copyFileSync(src, dest);
    stats.copied++;
  }

  // Files on disk that the manifest no longer lists.
  for (const name of readdirSync(outDir)) {
    if (AUDIO_EXT.has(extname(name).toLowerCase()) && !targets.has(name)) {
      console.warn(`  not in manifest (remove by hand if stale): varied/${name}`);
    }
  }
  return { stats, counts };
}

async function downloadFreesound(entry, dest) {
  const key = process.env.FREESOUND_API_KEY;
  if (!key) {
    console.warn(`  skipped Freesound #${entry.id}: set FREESOUND_API_KEY to download`);
    return "nokey";
  }
  const meta = await fetch(
    `https://freesound.org/apiv2/sounds/${entry.id}/?fields=id,name,license,previews&token=${encodeURIComponent(key)}`,
  );
  if (!meta.ok) {
    console.warn(`  Freesound #${entry.id}: HTTP ${meta.status}`);
    return "failed";
  }
  const info = await meta.json();
  if (!String(info.license).includes(CC0)) {
    console.warn(`  refused Freesound #${entry.id}: license is ${info.license}, not CC0`);
    return "failed";
  }
  const audio = await fetch(info.previews["preview-hq-mp3"]);
  if (!audio.ok) {
    console.warn(`  Freesound #${entry.id}: download HTTP ${audio.status}`);
    return "failed";
  }
  writeFileSync(dest, Buffer.from(await audio.arrayBuffer()));
  return "ok";
}

function findDuplicates(dir) {
  const seen = new Map();
  const dups = [];
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (!statSync(p).isFile() || !AUDIO_EXT.has(extname(name).toLowerCase())) continue;
    const h = sha256(p);
    if (seen.has(h)) dups.push([seen.get(h), name]);
    else seen.set(h, name);
  }
  return dups;
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
  const roots = { core: findCoreLibrary(), packs: join(homedir(), "Music/Ableton/Factory Packs") };
  const base = join(args.userLibrary, manifest.folder);
  console.log(`Test folder: ${base}`);
  console.log(`Core Library: ${roots.core ?? "(not found)"}`);

  console.log("edge-cases/");
  const made = buildEdgeCases(join(base, "edge-cases"), args.force);
  console.log(`  ${made} written, ${EDGE_CASES.length + 2 - made} already there`);

  console.log("varied/");
  const variedDir = join(base, "varied");
  const { stats, counts } = await buildVaried(manifest, roots, variedDir, args.force);
  console.log(`  ${stats.copied} copied, ${stats.skipped} unchanged, ${stats.missing} missing`);
  const renamed = manifest.varied.filter(
    (e) => e.target !== (e.originalName ?? basename(e.path ?? "")),
  ).length;
  console.log(`  ${manifest.varied.length} entries, ${renamed} badly named`);
  for (const [cat, n] of Object.entries(counts).sort()) console.log(`    ${cat.padEnd(12)} ${n}`);

  const dups = findDuplicates(variedDir);
  for (const [a, b] of dups) console.error(`  DUPLICATE: ${a} == ${b}`);

  if (args.bulk > 0) {
    console.log("bulk/");
    console.log(`  ${buildBulk(variedDir, join(base, "bulk"), args.bulk)} copies`);
  }

  if (dups.length > 0 || stats.missing > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
