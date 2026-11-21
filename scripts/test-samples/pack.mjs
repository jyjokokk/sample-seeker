#!/usr/bin/env node
// S24 (maintainer only): pack a staging directory of CC0 Freesound sounds into the test-sample release zip
// and write manifest.json.
//
//   node scripts/test-samples/pack.mjs --staging <dir> --version <n> [--out <dir>]
//
// <staging>/sources.json lists every sound ({ id, source, url, license, author, name, category, path }),
// with `path` relative to <staging>. The sounds are downloaded by hand on freesound.org, not through the API
// (its terms forbid re-hosting API content), so id, author and name come from sources.json and the
// website's <id>__<username>__<name>.<ext> file names. This script makes no network calls. The zip gets varied/<file> for each sound plus CREDITS.md, and is
// written to <out> (default: <repo>/.cache/test-samples, where build.mjs looks for it).
//
// Needs `zip` on PATH (Info-ZIP; ships with macOS and most Linux distributions).
// The zip is deterministic: sorted entries, fixed timestamps (in UTC), fixed permissions, no extra fields.
// Packing the same staging dir again with the same zip version gives the same sha256.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../..");
const MANIFEST = join(HERE, "manifest.json");
const FOLDER = "Samples/Sample Seeker Test";
const RELEASE_REPO = "jyjokokk/sample-seeker";
const AUDIO_EXT = new Set([".wav", ".aif", ".aiff", ".mp3", ".flac", ".ogg", ".m4a"]);
const CC0_LICENSE = /^https?:\/\/creativecommons\.org\/publicdomain\/zero\/1\.0\/?$/;
const CATEGORIES = new Set([
  "kick",
  "snare",
  "clap",
  "hihat",
  "cymbal",
  "tom",
  "perc",
  "drum-loop",
  "bass",
  "keys",
  "synth",
  "instrument",
  "stab",
  "vocal",
  "fx",
  "music-loop",
  "texture",
]);
const BAD_NAME_SHARE = 0.35;
// Every file in the zip gets this mtime, so the zip bytes don't depend on when the staging dir was made.
const FIXED_MTIME = new Date("2024-01-01T00:00:00Z");

const BAD_NAMES = [
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

const releaseTag = (version) => `test-samples-v${version}`;
const zipName = (version) => `sample-seeker-test-samples-v${version}.zip`;
const releaseUrl = (version) =>
  `https://github.com/${RELEASE_REPO}/releases/download/${releaseTag(version)}/${zipName(version)}`;

// ---------- args ----------

function parseArgs(argv) {
  const args = { staging: null, version: null, out: join(REPO, ".cache/test-samples") };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--staging") args.staging = argv[++i];
    else if (a === "--version") args.version = Number(argv[++i]);
    else if (a === "--out") args.out = argv[++i];
    else if (a === "-h" || a === "--help") {
      console.log("usage: pack.mjs --staging <dir> --version <n> [--out <dir>]");
      process.exit(0);
    } else throw new Error(`unknown argument: ${a}`);
  }
  if (!args.staging) throw new Error("--staging <dir> is required");
  if (!Number.isInteger(args.version) || args.version < 1)
    throw new Error("--version must be a positive integer");
  args.staging = resolve(args.staging);
  args.out = resolve(args.out);
  return args;
}

// ---------- helpers ----------

const sha256 = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
const hash = (s) => createHash("sha256").update(s).digest();

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: "utf8", ...opts });
  if (r.error) throw new Error(`could not run ${cmd}: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`${cmd} failed: ${(r.stderr || r.stdout).trim()}`);
  return r.stdout;
}

// ---------- validation ----------

function validate(staging) {
  const sourcesPath = join(staging, "sources.json");
  if (!existsSync(sourcesPath)) throw new Error(`not found: ${sourcesPath}`);
  const { samples } = JSON.parse(readFileSync(sourcesPath, "utf8"));
  if (!Array.isArray(samples) || samples.length === 0)
    throw new Error("sources.json: `samples` must be a non-empty array");

  const errors = [];
  const ids = new Set();
  const hashes = new Map();
  const valid = [];
  for (const [i, s] of samples.entries()) {
    const where = `samples[${i}] (id ${s.id})`;
    const before = errors.length;
    if (!Number.isInteger(s.id) || s.id < 1) errors.push(`${where}: id must be a positive integer`);
    else if (ids.has(s.id)) errors.push(`${where}: duplicate id`);
    ids.add(s.id);
    if (s.source !== "freesound") errors.push(`${where}: source must be "freesound"`);
    if (!CC0_LICENSE.test(String(s.license)))
      errors.push(`${where}: license is not CC0: ${s.license}`);
    if (!CATEGORIES.has(s.category)) errors.push(`${where}: unknown category: ${s.category}`);
    for (const field of ["url", "author", "name", "path"])
      if (typeof s[field] !== "string" || s[field] === "")
        errors.push(`${where}: missing ${field}`);
    if (errors.length > before) continue;

    const abs = resolve(staging, s.path);
    const rel = relative(staging, abs);
    if (rel.startsWith("..") || isAbsolute(rel)) {
      errors.push(`${where}: path is outside the staging dir: ${s.path}`);
      continue;
    }
    if (!AUDIO_EXT.has(extname(abs).toLowerCase())) {
      errors.push(`${where}: not an audio file extension: ${s.path}`);
      continue;
    }
    if (!existsSync(abs) || !statSync(abs).isFile()) {
      errors.push(`${where}: file not found: ${s.path}`);
      continue;
    }
    // A file that still has its freesound.org download name, <id>__<username>__<name>.<ext>,
    // must agree with sources.json, so a mix-up during import can't credit the wrong sound.
    const website = basename(abs).match(/^(\d+)__(.+?)__/);
    if (website && (Number(website[1]) !== s.id || website[2] !== s.author)) {
      errors.push(
        `${where}: file name says id ${website[1]} by ${website[2]}, sources.json says id ${s.id} by ${s.author}`,
      );
      continue;
    }
    const digest = sha256(abs);
    if (hashes.has(digest)) {
      errors.push(`${where}: same content as id ${hashes.get(digest)} (${s.path})`);
      continue;
    }
    hashes.set(digest, s.id);
    valid.push({ ...s, abs, sha256: digest });
  }
  if (errors.length > 0) {
    for (const e of errors) console.error(`  ${e}`);
    throw new Error(`sources.json: ${errors.length} problem(s), nothing packed`);
  }
  return valid;
}

// ---------- file names ----------

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)$/i;

// A file-system-safe version of the Freesound name: ASCII only (so the zip unpacks the same everywhere),
// no path separators or characters Windows rejects, and without the extension Freesound names often carry.
function sanitizeName(name, ext) {
  // NFKD splits "ä" into "a" + a combining mark (U+0300–U+036F), which is then dropped.
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

// Whether a sound gets a bad generic name, and which, depends only on its Freesound id,
// so growing the set never renames an existing file.
const badNameHash = (id) => hash(`badname:freesound:${id}`);
const hasBadName = (id) => badNameHash(id)[0] / 256 < BAD_NAME_SHARE;

function targetName(sample) {
  const ext = extname(sample.path).toLowerCase();
  if (!hasBadName(sample.id)) return sanitizeName(sample.name, ext);
  const h = badNameHash(sample.id);
  return BAD_NAMES[h[1] % BAD_NAMES.length](1 + (((h[2] << 8) | h[3]) % 999)) + ext;
}

// Sounds already in manifest.json keep their file name. New ones are named in id order; a name that is
// taken (case-insensitively, for macOS and Windows) gets " 2", " 3", … before the extension.
function assignFiles(samples, previous) {
  const pinned = new Map((previous?.samples ?? []).map((e) => [e.id, e.file]));
  const used = new Set();
  const files = new Map();
  for (const s of samples) {
    const file = pinned.get(s.id);
    if (file && !used.has(file.toLowerCase())) {
      used.add(file.toLowerCase());
      files.set(s.id, file.slice("varied/".length));
    }
  }
  for (const s of [...samples].sort((a, b) => a.id - b.id)) {
    if (files.has(s.id)) continue;
    const name = targetName(s);
    const ext = extname(name);
    const stem = name.slice(0, -ext.length);
    let candidate = name;
    for (let n = 2; used.has(`varied/${candidate}`.toLowerCase()); n++)
      candidate = `${stem} ${n}${ext}`;
    used.add(`varied/${candidate}`.toLowerCase());
    files.set(s.id, candidate);
  }
  return files;
}

// ---------- credits ----------

const cell = (s) => String(s).replace(/\|/g, "\\|").replace(/\s+/g, " ");

function credits(version, entries) {
  const rows = [...entries]
    .sort((a, b) => a.file.localeCompare(b.file, "en"))
    .map(
      (e) =>
        `| ${cell(e.file)} | ${e.id} | ${cell(e.name)} | ${cell(e.author)} | ${e.url} | ${e.license} |`,
    );
  return [
    `# Sample Seeker test samples, v${version}`,
    "",
    `All ${entries.length} sounds in \`varied/\` come from Freesound (https://freesound.org) and were released`,
    "by their authors under Creative Commons 0 (CC0 1.0 Universal,",
    "https://creativecommons.org/publicdomain/zero/1.0/): they are in the public domain and need no",
    "attribution. We credit the authors anyway, with thanks.",
    "",
    "Some files were deliberately given generic names (e.g. `smpl_297.wav`) to test search that doesn't",
    "rely on file names. The original Freesound name is listed for every file.",
    "",
    "| File | Freesound ID | Original name | Author | URL | License |",
    "| ---- | ------------ | ------------- | ------ | --- | ------- |",
    ...rows,
    "",
  ].join("\n");
}

// ---------- zip ----------

function writeZip(tmp, zipPath, files) {
  run("zip", ["-v"]); // fail early with a clear message if zip is missing
  const fix = (p, mode) => {
    chmodSync(p, mode);
    utimesSync(p, FIXED_MTIME, FIXED_MTIME);
  };
  fix(join(tmp, "varied"), 0o755);
  for (const f of files) fix(join(tmp, f), 0o644);
  rmSync(zipPath, { force: true });
  // -X: no extra fields (uid/gid, extended timestamps). -D: no directory entries.
  // -@: entry names from stdin, in our sorted order. TZ=UTC: DOS timestamps are local time otherwise.
  run("zip", ["-q", "-X", "-D", "-9", zipPath, "-@"], {
    cwd: tmp,
    input: `${files.join("\n")}\n`,
    env: { ...process.env, TZ: "UTC" },
  });
}

// ---------- main ----------

function main() {
  const args = parseArgs(process.argv.slice(2));
  const previous = existsSync(MANIFEST) ? JSON.parse(readFileSync(MANIFEST, "utf8")) : null;

  console.log(`Staging: ${args.staging}`);
  const samples = validate(args.staging);
  const files = assignFiles(samples, previous);

  const entries = samples
    .map((s) => ({
      id: s.id,
      url: s.url,
      license: s.license,
      author: s.author,
      name: s.name,
      category: s.category,
      file: `varied/${files.get(s.id)}`,
      sha256: s.sha256,
      abs: s.abs,
    }))
    .sort((a, b) => a.id - b.id);

  mkdirSync(args.out, { recursive: true });
  const tmp = join(args.out, `pack-v${args.version}.tmp`);
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(join(tmp, "varied"), { recursive: true });
  for (const e of entries) copyFileSync(e.abs, join(tmp, e.file));
  writeFileSync(join(tmp, "CREDITS.md"), credits(args.version, entries));

  const zipPath = join(args.out, zipName(args.version));
  const zipEntries = ["CREDITS.md", ...entries.map((e) => e.file).sort()];
  writeZip(tmp, zipPath, zipEntries);
  rmSync(tmp, { recursive: true, force: true });

  const release = {
    version: args.version,
    url: releaseUrl(args.version),
    sha256: sha256(zipPath),
    bytes: statSync(zipPath).size,
  };
  if (previous?.release?.version === args.version && previous.release.sha256 !== release.sha256)
    console.warn(
      `  WARNING: v${args.version} was already packed with different content. If it is published, ` +
        "bump --version instead of replacing the release asset.",
    );

  const manifest = {
    folder: FOLDER,
    release,
    samples: entries.map(({ abs, ...e }) => e),
  };
  writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);

  const counts = {};
  for (const e of entries) counts[e.category] = (counts[e.category] ?? 0) + 1;
  const renamed = entries.filter((e) => hasBadName(e.id)).length;
  console.log(`  ${entries.length} sounds, ${renamed} with a bad generic name`);
  for (const [cat, n] of Object.entries(counts).sort()) console.log(`    ${cat.padEnd(12)} ${n}`);
  console.log(`Zip: ${zipPath}`);
  console.log(`  ${release.bytes} bytes, sha256 ${release.sha256}`);
  console.log(`Wrote ${relative(REPO, MANIFEST)}`);
  console.log("\nCheck it with `pnpm test-samples --zip <zip>`, then publish it:\n");
  console.log(
    `  gh release create ${releaseTag(args.version)} "${zipPath}" --repo ${RELEASE_REPO} ` +
      `--title "Test samples v${args.version}" --latest=false ` +
      `--notes "CC0 test samples for Sample Seeker (S24). Credits: CREDITS.md in the zip."`,
  );
  console.log("\nand commit scripts/test-samples/manifest.json.");
}

try {
  main();
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
