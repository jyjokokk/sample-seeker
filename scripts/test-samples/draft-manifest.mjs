#!/usr/bin/env node
// S24: draft manifest.json from the Ableton content installed on this machine.
//
//   node scripts/test-samples/draft-manifest.mjs --total <n>
//
// Picks are deterministic and prefix-stable: raising --total keeps every earlier pick and adds more.
// Whether a file gets a bad name is decided by a hash of its path, so that is stable too.
// Freesound entries already in manifest.json are kept as they are. Review the result before committing.

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const AUDIO_EXT = new Set([".wav", ".aif", ".aiff"]);
const BAD_NAME_SHARE = 0.35;

// category → source folders (relative to the Core Library or to a Factory Pack), and relative weight.
const CATEGORIES = {
  kick: { weight: 1, dirs: ["core:Samples/One Shots/Drums/Kick", "pack:Build and Drop:Samples/One Shots/Kick"] },
  snare: { weight: 1, dirs: ["core:Samples/One Shots/Drums/Snare", "pack:Build and Drop:Samples/One Shots/Snare"] },
  clap: { weight: 0.7, dirs: ["core:Samples/One Shots/Drums/Clap", "pack:Build and Drop:Samples/One Shots/Clap"] },
  hihat: { weight: 1, dirs: ["core:Samples/One Shots/Drums/Hihat", "pack:Build and Drop:Samples/One Shots/Hihat"] },
  cymbal: {
    weight: 0.7,
    dirs: [
      "core:Samples/One Shots/Drums/Cymbal", "core:Samples/One Shots/Drums/Ride",
      "pack:Build and Drop:Samples/One Shots/Cymbal", "pack:Build and Drop:Samples/One Shots/Ride",
    ],
  },
  tom: { weight: 0.6, dirs: ["core:Samples/One Shots/Drums/Tom", "pack:Build and Drop:Samples/One Shots/Tom"] },
  perc: {
    weight: 1,
    dirs: [
      "core:Samples/One Shots/Drums/Misc Percussion", "core:Samples/One Shots/Drums/Bongo",
      "core:Samples/One Shots/Drums/Conga", "core:Samples/One Shots/Drums/Electronic Percussion",
      "core:Samples/One Shots/Drums/Bell", "core:Samples/One Shots/Drums/Rim",
      "pack:Build and Drop:Samples/One Shots/Misc Percussion", "pack:Build and Drop:Samples/One Shots/Shaker",
      "pack:Build and Drop:Samples/One Shots/Wood", "pack:Build and Drop:Samples/One Shots/Rim",
    ],
  },
  "drum-loop": { weight: 1.3, dirs: ["core:Samples/Loops/Drums", "pack:Build and Drop:Samples/Loops/Drum Loops"] },
  bass: {
    weight: 1,
    dirs: ["core:Samples/One Shots/Instrument/Bass", "pack:Build and Drop:Samples/One Shots/Bass"],
  },
  keys: {
    weight: 1,
    dirs: [
      "core:Samples/One Shots/Instrument/Piano & Keys", "core:Samples/One Shots/Instrument/Mallets",
      "core:Samples/Multisamples/Grand Piano", "core:Samples/Multisamples/Upright Home Piano",
    ],
  },
  synth: {
    weight: 1.2,
    dirs: [
      "core:Samples/One Shots/Instrument/Synth", "core:Samples/Multisamples/Synths",
      "pack:Build and Drop:Samples/One Shots/Synth",
    ],
  },
  instrument: {
    weight: 0.8,
    dirs: [
      "core:Samples/One Shots/Instrument/Brass", "core:Samples/One Shots/Instrument/Guitar & Plucked",
      "core:Samples/One Shots/Instrument/Strings", "core:Samples/One Shots/Instrument/Winds",
    ],
  },
  stab: { weight: 0.7, dirs: ["core:Samples/One Shots/Stab", "pack:Build and Drop:Samples/One Shots/Stabs"] },
  vocal: {
    weight: 1,
    dirs: [
      "core:Samples/One Shots/Vocal", "core:Samples/Loops/Tonal/Vocal",
      "pack:Build and Drop:Samples/One Shots/Vocal",
    ],
  },
  fx: {
    weight: 1,
    dirs: [
      "core:Samples/One Shots/FX", "core:Samples/One Shots/Drums/FX Hit", "core:Samples/Loops/FX",
      "pack:Build and Drop:Samples/One Shots/FX Hit", "pack:Build and Drop:Samples/One Shots/Builds and Risers",
      "pack:Build and Drop:Samples/One Shots/Drops",
    ],
  },
  "music-loop": {
    weight: 1.2,
    dirs: [
      "core:Samples/Loops/Tonal/Guitar", "core:Samples/Loops/Tonal/Keys", "core:Samples/Loops/Tonal/Synth",
      "pack:Build and Drop:Samples/Loops/Music Loops",
    ],
  },
  texture: { weight: 0.6, dirs: ["core:Samples/Loops/Texture"] },
};

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

function findCoreLibrary() {
  const apps = readdirSync("/Applications").filter((n) => /^Ableton Live .*\.app$/.test(n)).sort().reverse();
  for (const app of apps) {
    const p = join("/Applications", app, "Contents/App-Resources/Core Library");
    if (existsSync(p)) return p;
  }
  throw new Error("Ableton Core Library not found");
}

function walk(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).sort().flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return walk(p);
    return AUDIO_EXT.has(extname(name).toLowerCase()) ? [p] : [];
  });
}

// Stable sort key per file: a hash, so the order is "random" but the same everywhere.
const hash = (s) => createHash("sha256").update(s).digest();

function candidates(spec, roots) {
  const [kind, ...rest] = spec.split(":");
  let source, root, rel;
  if (kind === "core") { source = "core"; root = roots.core; rel = rest.join(":"); }
  else { source = `pack:${rest[0]}`; root = join(roots.packs, rest[0]); rel = rest.slice(1).join(":"); }
  return walk(join(root, rel)).map((abs) => ({ source, path: relative(root, abs) }));
}

function main() {
  const totalIdx = process.argv.indexOf("--total");
  const total = totalIdx > 0 ? Number(process.argv[totalIdx + 1]) : 25;
  const roots = { core: findCoreLibrary(), packs: join(homedir(), "Music/Ableton/Factory Packs") };

  const manifestPath = join(HERE, "manifest.json");
  const old = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, "utf8")) : null;
  const freesound = old?.varied.filter((e) => e.source === "freesound") ?? [];

  const weightSum = Object.values(CATEGORIES).reduce((s, c) => s + c.weight, 0);
  const remaining = total - freesound.length;
  const entries = [];
  const takenGroups = new Set(); // one note per multisample instrument
  const takenNames = new Set();  // Ableton ships some identical files under the same name in several places

  for (const [category, { weight, dirs }] of Object.entries(CATEGORIES)) {
    const want = Math.max(1, Math.round((remaining * weight) / weightSum));
    const pool = dirs.flatMap((d) => candidates(d, roots))
      .sort((a, b) => Buffer.compare(hash(a.path), hash(b.path)));
    let got = 0;
    for (const c of pool) {
      if (got >= want) break;
      if (c.path.includes("Multisamples/")) {
        const group = dirname(c.path);
        if (takenGroups.has(group)) continue;
        takenGroups.add(group);
      }
      const name = basename(c.path).toLowerCase();
      if (takenNames.has(name)) continue;
      takenNames.add(name);
      entries.push({ ...c, category });
      got++;
    }
  }

  // Bad names: pattern and number both come from the file's hash, so growing the set never renames a file.
  const used = new Set(freesound.map((e) => e.target));
  const varied = entries.map((e) => {
    const h = hash(`badname:${e.path}`);
    const ext = extname(e.path);
    let target = basename(e.path);
    if (h[0] / 256 < BAD_NAME_SHARE) target = BAD_NAMES[h[1] % BAD_NAMES.length](1 + (((h[2] << 8) | h[3]) % 999)) + ext;
    while (used.has(target)) target = `${basename(target, ext)} 2${ext}`;
    used.add(target);
    return { source: e.source, path: e.path, category: e.category, target };
  });

  const manifest = {
    folder: old?.folder ?? "Samples/Sample Seeker Test",
    note: old?.note ?? "Ableton entries are copied from local Live content and must never be committed or shared (EULA §5(3)). Freesound entries must be CC0.",
    varied: [...varied, ...freesound],
  };
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  console.log(`wrote ${manifest.varied.length} entries (${varied.length} Ableton, ${freesound.length} Freesound)`);
}

main();
