# Test samples (S24)

A known, repeatable sample set for decoding (S3), the CLAP spike (S4), the search benchmark (S5) and
indexing (S6). It is the same on every machine. The audio lives in Ableton's User Library, so Live's
browser sees the same files:

```
<User Library>/Samples/Sample Seeker Test/
  varied/      ~300 CC0 Freesound sounds across categories, ~35 % with bad names (benchmark set)
  CREDITS.md   source, author and license of every varied/ file
  edge-cases/  one file per format / failure case, generated from synthetic tones and noise
  bulk/        optional copies, only for indexing-speed and incremental-skip tests
```

`varied/` comes from a zip published as a GitHub Release asset on this repo (tag `test-samples-v<n>`).
`manifest.json` says which release to use and lists every file with its sha256.

## Build (everyone)

```bash
pnpm test-samples                          # edge-cases/ + varied/
pnpm test-samples --bulk 500               # also fill bulk/ with 500 copies
pnpm test-samples --user-library <path>    # non-default User Library
pnpm test-samples --force                  # rewrite everything
pnpm test-samples --zip <path>             # use a local zip instead of downloading the release
```

The default User Library is `~/Music/Ableton/User Library` on macOS and
`~/Documents/Ableton/User Library` on Windows (Live: Settings → Library). Elsewhere, pass `--user-library`.

The zip is downloaded once to `.cache/test-samples/` (gitignored) and checked against the size and sha256
in `manifest.json`. Every extracted file is checked against its sha256 too; a file that doesn't match is
not copied and the run fails. Re-running only writes what is missing or changed. Files in `varied/` that
the manifest doesn't list are reported, not deleted.

Needs:

- `ffmpeg` on PATH (or `FFMPEG=/path/to/ffmpeg`), for `edge-cases/`.
- `unzip`, or a `tar` that reads zip files (bsdtar: macOS, Windows 10+). Most Linux systems have `unzip`.

## Publish a new set (maintainer)

The sounds are downloaded **by hand** on freesound.org, never through the API or a script: the API terms
forbid re-hosting content obtained through the API (§4(a)), and scripting the website would be scraping
(§4(f)). Nothing in this folder talks to Freesound.

1. **Curate** candidate sound IDs: CC0 only, spread across the categories below.
2. **Re-check** (before every new release, including for sounds already in the set) that each sound is still
   online and still CC0. Drop any that aren't.
3. **Download** each sound by hand on freesound.org while logged in. The website names files
   `<id>__<username>__<original name>.<ext>`.
4. **Import** the downloads into a staging directory with a `sources.json`. id, author and name come from
   the file name and the sound's page:

   ```json
   { "samples": [ { "id": 12345, "source": "freesound", "url": "https://freesound.org/s/12345/",
       "license": "http://creativecommons.org/publicdomain/zero/1.0/", "author": "username",
       "name": "<original Freesound name>", "category": "kick", "path": "kick/12345-<slug>.wav" } ] }
   ```

   `path` is relative to the staging directory. Categories: kick, snare, clap, hihat, cymbal, tom, perc,
   drum-loop, bass, keys, synth, instrument, stab, vocal, fx, music-loop, texture.

5. **Pack** it, with the next version number:

   ```bash
   node scripts/test-samples/pack.mjs --staging <dir> --version <n> [--out <dir>]
   ```

   This checks every entry (file exists, license is CC0, no duplicate ids or content, and a file that still
   has its website name agrees with sources.json on id and username), names the files,
   writes `sample-seeker-test-samples-v<n>.zip` (default: `.cache/test-samples/`) with `varied/` and
   `CREDITS.md`, and rewrites `manifest.json`. Nothing is written if any entry fails. Needs `zip` on PATH.

6. **Check** it: `pnpm test-samples --zip <zip>`.
7. **Publish** it with the `gh release create …` command that `pack.mjs` prints.
8. **Commit** `manifest.json`.

Never replace the asset of a published version: bump `--version` instead, or everyone's sha256 check fails.

File names in `varied/`:

- ~35 % of the sounds get a bad generic name (`smpl_297.wav`, `New Recording 86.wav`, …). Whether a
  sound gets one, and which, depends only on its Freesound id.
- The rest keep their Freesound name, made safe for file systems (ASCII only, no `/ \ : * ? " < > |`).
- Sounds already in `manifest.json` keep their file name, so growing the set never renames a file.
  A clash (ignoring case) gets ` 2`, ` 3`, … before the extension.

The zip is deterministic: sorted entries, fixed timestamps and permissions, no extra fields. Packing the
same staging directory again with the same `zip` version gives the same sha256.

## manifest.json

```json
{
  "folder": "Samples/Sample Seeker Test",
  "release": {
    "version": 1,
    "url": "https://github.com/…/sample-seeker-test-samples-v1.zip",
    "sha256": "…",
    "bytes": 123
  },
  "samples": [
    {
      "id": 12345,
      "url": "…",
      "license": "…",
      "author": "…",
      "name": "<original name>",
      "category": "kick",
      "file": "varied/smpl_297.wav",
      "sha256": "…"
    }
  ]
}
```

`release` is `null` until the first set is published. `name` (the original Freesound name) and `category`
are the ground truth for writing `queries.json` (S5), whether or not `file` got a bad name.

## Edge cases

| File                         | What it tests                                           |
| ---------------------------- | ------------------------------------------------------- |
| `wav-16bit-stereo-44k.wav`   | 16-bit WAV, stereo                                      |
| `wav-24bit-mono-48k.wav`     | 24-bit WAV, mono, 48 kHz                                |
| `wav-32float-stereo-96k.wav` | 32-bit float, 96 kHz (resampling)                       |
| `aiff-16bit-stereo-44k.aif`  | AIFF (big-endian PCM)                                   |
| `mp3-stereo-44k.mp3`         | MP3                                                     |
| `flac-24bit-mono-48k.flac`   | FLAC                                                    |
| `long-45s-stereo.wav`        | longer than the 30 s decode cap                         |
| `corrupt.wav`                | RIFF/WAVE header followed by garbage; must fail cleanly |
| `empty.wav`                  | 0 bytes; must fail cleanly                              |

## Licensing

- **CC0 only.** Every sound in the set is Freesound CC0 (public domain); `pack.mjs` refuses anything else.
- **Downloaded by hand, never through the Freesound API** (API terms §4(a) forbid re-hosting API content;
  scripting the website would be scraping, §4(f)).
  `CREDITS.md` in the zip credits every sound anyway.
- **No audio in the repo.** `.gitignore` blocks audio files repo-wide. The audio is only in the release zip.
- **No Ableton content.** Its EULA forbids redistributing it (§5(3)), and every machine has a different
  library, so the set wouldn't be the same everywhere.
