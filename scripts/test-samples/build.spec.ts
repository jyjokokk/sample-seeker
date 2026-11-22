import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildBulk,
  buildEdgeCases,
  buildVaried,
  type Manifest,
  sanitizeName,
  targetName,
  uniqueName,
} from "./build.ts";
import { downloadOriginal, type SoundInfo, soundInfos } from "./freesound.ts";

// The Freesound API client is the network boundary. The fake serves sounds from `catalog`, and its
// downloadOriginal writes the file and returns the sha256, like the real one.
const catalog = vi.hoisted(() => new Map<number, { info: SoundInfo; audio: string }>());
vi.mock("./freesound.ts", () => ({
  AuthError: class AuthError extends Error {},
  authorizeUrl: vi.fn(),
  exchangeCode: vi.fn(),
  soundInfos: vi.fn(async (ids: number[]) => {
    const infos = new Map<number, SoundInfo>();
    for (const id of ids) {
      const sound = catalog.get(id);
      if (sound) infos.set(id, sound.info);
    }
    return infos;
  }),
  downloadOriginal: vi.fn(async (id: number, dest: string) => {
    const { audio } = catalog.get(id) ?? { audio: "" };
    writeFileSync(dest, audio);
    return sha(audio);
  }),
}));

// ffmpeg is the other boundary. The fake writes a placeholder to the output file (its last argument).
vi.mock("node:child_process", () => ({
  spawnSync: vi.fn((_bin: string, args: string[]) => {
    writeFileSync(args[args.length - 1], "ffmpeg output");
    return { status: 0, stderr: "" };
  }),
}));

const CC0 = "http://creativecommons.org/publicdomain/zero/1.0/";
const sha = (data: string) => createHash("sha256").update(data).digest("hex");

function publish(id: number, info: Partial<SoundInfo> = {}, audio = `audio of ${id}`) {
  catalog.set(id, {
    info: {
      id,
      name: `sound ${id}`,
      username: "someone",
      license: CC0,
      type: "wav",
      url: `https://freesound.org/s/${id}/`,
      ...info,
    },
    audio,
  });
}

// Ids whose file name comes from the Freesound name (the rest get a generic bad name).
const PLAIN_IDS = Array.from({ length: 300 }, (_, i) => i + 1).filter(
  (id) => targetName(id, "x", ".wav") === "x.wav",
);

const manifestOf = (...samples: Manifest["samples"]): Manifest => ({ folder: "unused", samples });
const sample = (id: number, pinned?: string) => ({ id, category: "kick", sha256: pinned });

describe("build", () => {
  let base: string;
  const varied = () => join(base, "varied");
  const readIndex = () =>
    (
      JSON.parse(readFileSync(join(base, "samples.json"), "utf8")) as {
        samples: { id: number; file: string }[];
      }
    ).samples;
  const fileOf = (id: number) => readIndex().find((e) => e.id === id)?.file ?? "";

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "build-spec-"));
    catalog.clear();
    vi.mocked(downloadOriginal).mockClear();
    vi.mocked(soundInfos).mockClear();
    for (const method of ["log", "warn", "error"] as const)
      vi.spyOn(console, method).mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(base, { recursive: true, force: true });
  });

  describe("buildVaried", () => {
    it("downloads each manifest sound into varied/ and records it in samples.json and CREDITS.md", async () => {
      publish(808, { name: "Big | Kick", username: "drummer" }, "kick audio");

      const { stats } = await buildVaried(manifestOf(sample(808)), base, false);

      expect(stats).toEqual({ downloaded: 1, unchanged: 0, rejected: 0 });
      const [entry] = readIndex();
      expect(entry).toMatchObject({
        id: 808,
        category: "kick",
        name: "Big | Kick",
        author: "drummer",
      });
      expect(entry).toMatchObject({
        sha256: sha("kick audio"),
        url: "https://freesound.org/s/808/",
      });
      expect(readFileSync(join(varied(), entry.file), "utf8")).toBe("kick audio");
      expect(readFileSync(join(base, "CREDITS.md"), "utf8")).toContain(
        `| ${entry.file} | [808](https://freesound.org/s/808/) | Big \\| Kick | drummer | CC0 1.0 |`,
      );
    });

    it("skips sounds whose file still matches the pinned sha256", async () => {
      publish(1);
      const manifest = manifestOf(sample(1, sha("audio of 1")));
      await buildVaried(manifest, base, false);
      vi.mocked(downloadOriginal).mockClear();

      const { stats } = await buildVaried(manifest, base, false);

      expect(stats).toEqual({ downloaded: 0, unchanged: 1, rejected: 0 });
      expect(downloadOriginal).not.toHaveBeenCalled();
    });

    it("downloads a sound again when its file has changed on disk", async () => {
      publish(1);
      const manifest = manifestOf(sample(1, sha("audio of 1")));
      await buildVaried(manifest, base, false);
      writeFileSync(join(varied(), fileOf(1)), "edited");

      const { stats } = await buildVaried(manifest, base, false);

      expect(stats.downloaded).toBe(1);
      expect(readFileSync(join(varied(), fileOf(1)), "utf8")).toBe("audio of 1");
    });

    it("rejects a download that doesn't match the pinned sha256 and leaves no file behind", async () => {
      publish(1, {}, "changed upstream");

      const { stats, index } = await buildVaried(
        manifestOf(sample(1, sha("audio of 1"))),
        base,
        false,
      );

      expect(stats.rejected).toBe(1);
      expect(index.has(1)).toBe(false);
      expect(readdirSync(varied())).toEqual([]);
    });

    it.each([
      ["no longer on Freesound", () => {}],
      [
        "no longer CC0",
        () => publish(1, { license: "http://creativecommons.org/licenses/by/4.0/" }),
      ],
      ["of a file type the script doesn't know", () => publish(1, { type: "wma" })],
    ])("rejects a sound without downloading it when it is %s", async (_, arrange) => {
      arrange();
      publish(2);

      const { stats, index } = await buildVaried(manifestOf(sample(1), sample(2)), base, false);

      expect(stats).toEqual({ downloaded: 1, unchanged: 0, rejected: 1 });
      expect([...index.keys()]).toEqual([2]);
      expect(vi.mocked(downloadOriginal).mock.calls.map(([id]) => id)).toEqual([2]);
    });

    it("forgets sounds removed from the manifest but keeps their files", async () => {
      publish(1);
      publish(2);
      await buildVaried(manifestOf(sample(1), sample(2)), base, false);
      const removedFile = fileOf(2);

      await buildVaried(manifestOf(sample(1)), base, false);

      expect(readIndex().map((e) => e.id)).toEqual([1]);
      expect(existsSync(join(varied(), removedFile))).toBe(true);
    });

    it("doesn't overwrite an earlier sound's file with a new sound of the same name in another case", async () => {
      const [first, second] = PLAIN_IDS;
      publish(first, { name: "Kick" });
      await buildVaried(manifestOf(sample(first)), base, false);
      publish(second, { name: "kick" });

      await buildVaried(manifestOf(sample(first), sample(second)), base, false);

      expect([fileOf(first), fileOf(second)]).toEqual(["Kick.wav", "kick 2.wav"]);
      expect(readFileSync(join(varied(), "Kick.wav"), "utf8")).toBe(`audio of ${first}`);
    });

    it("removes a sound's old file when it is downloaded again under a new name", async () => {
      const [id] = PLAIN_IDS;
      publish(id, { name: "Old name" });
      await buildVaried(manifestOf(sample(id)), base, false);
      publish(id, { name: "New name" });

      await buildVaried(manifestOf(sample(id)), base, true);

      expect(readdirSync(varied()).sort()).toEqual(["New name.wav"]);
    });
  });

  describe("buildEdgeCases", () => {
    const edgeCases = () => join(base, "edge-cases");

    it("writes corrupt.wav as a WAV header followed by the same garbage on every run", () => {
      buildEdgeCases(edgeCases(), false);
      const first = readFileSync(join(edgeCases(), "corrupt.wav"));

      buildEdgeCases(edgeCases(), true);

      const second = readFileSync(join(edgeCases(), "corrupt.wav"));
      expect(second.subarray(0, 4).toString()).toBe("RIFF");
      expect(second.subarray(8, 12).toString()).toBe("WAVE");
      expect(second.length).toBeGreaterThan(12);
      expect(second.equals(first)).toBe(true);
      expect(readFileSync(join(edgeCases(), "empty.wav"))).toHaveLength(0);
    });

    it("keeps edge cases that already exist unless forced", () => {
      const all = buildEdgeCases(edgeCases(), false);
      const kept = join(edgeCases(), readdirSync(edgeCases())[0]);
      writeFileSync(kept, "already there");

      const madeAgain = buildEdgeCases(edgeCases(), false);
      const contentAfterRerun = readFileSync(kept, "utf8");
      const madeForced = buildEdgeCases(edgeCases(), true);

      expect(all).toBe(readdirSync(edgeCases()).length);
      expect(madeAgain).toBe(0);
      expect(contentAfterRerun).toBe("already there");
      expect(madeForced).toBe(all);
      expect(readFileSync(kept, "utf8")).not.toBe("already there");
    });

    it.each([
      [
        "isn't installed",
        { error: new Error("spawnSync ffmpeg ENOENT"), status: null, stderr: "" },
        /could not run .+: spawnSync ffmpeg ENOENT \(install ffmpeg or set FFMPEG\)/,
      ],
      [
        "fails",
        { status: 1, stderr: "Unknown encoder 'libmp3lame'\n" },
        /^ffmpeg failed: Unknown encoder 'libmp3lame'$/,
      ],
    ])("throws when ffmpeg %s", (_, result, message) => {
      vi.mocked(spawnSync).mockReturnValueOnce(result as unknown as ReturnType<typeof spawnSync>);

      expect(() => buildEdgeCases(edgeCases(), false)).toThrow(message);
    });
  });

  describe("buildBulk", () => {
    it("keeps exactly n numbered copies of the first 10 sounds", () => {
      mkdirSync(varied());
      const files = ["a.wav", "b.wav"];
      for (const file of files) writeFileSync(join(varied(), file), file);
      const index = new Map(
        files.map((file, i) => [
          i,
          { id: i, category: "kick", file, name: file, author: "", url: "", sha256: "" },
        ]),
      );
      const bulk = join(base, "bulk");
      buildBulk(varied(), bulk, index, 5);

      buildBulk(varied(), bulk, index, 3);

      expect(readdirSync(bulk).sort()).toEqual(["0000 a.wav", "0001 b.wav", "0002 a.wav"]);
      expect(readFileSync(join(bulk, "0002 a.wav"), "utf8")).toBe("a.wav");
    });
  });

  describe("sanitizeName", () => {
    it.each([
      ["drops an audio extension already in the name", "Kick.WAV", "Kick.wav"],
      ["turns accented letters into ASCII", "Bäss Drüm", "Bass Drum.wav"],
      ["replaces characters Windows rejects", 'a<b>:c"d/e\\f|g?h*', "a_b__c_d_e_f_g_h_.wav"],
      ["trims leading dots and spaces", " ..hidden. ", "hidden.wav"],
      ["prefixes names Windows reserves", "CON", "freesound CON.wav"],
      ["names an empty name", "...", "freesound.wav"],
      ["shortens long names to 100 characters", "x".repeat(150), `${"x".repeat(100)}.wav`],
    ])("%s", (_, name, expected) => {
      expect(sanitizeName(name, ".wav")).toBe(expected);
    });
  });

  describe("uniqueName", () => {
    it("numbers a name taken in any letter case", () => {
      const used = new Set<string>();

      const names = ["Kick.wav", "kick.wav", "KICK.wav"].map((name) => uniqueName(name, used));

      expect(names).toEqual(["Kick.wav", "kick 2.wav", "KICK 3.wav"]);
    });
  });
});
