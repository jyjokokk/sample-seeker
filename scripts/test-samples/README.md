# Test samples (S24)

A known, repeatable sample set for decoding (S3), the CLAP spike (S4), the search benchmark (S5) and
indexing (S6). It is the same on every machine. The audio lives in Ableton's User Library, so Live's
browser sees the same files:

```
<User Library>/Samples/Sample Seeker Test/
  varied/       ~150 CC0 Freesound sounds across categories, ~35 % with bad names (benchmark set)
  samples.json  id, category, original name and author of every varied/ file (local ground truth)
  CREDITS.md    source, author and license of every varied/ file
  edge-cases/   one file per format / failure case, generated from synthetic tones and noise
  bulk/         optional copies, only for indexing-speed and incremental-skip tests
```

`varied/` is downloaded from Freesound by **each developer, with their own Freesound account**. The set is
never re-hosted: Freesound's API terms forbid publishing content obtained through the API (§4(a)).
`manifest.json` lists the sounds by Freesound id, category and sha256, so everyone gets byte-identical files.

## Setup (once)

1. Create a free Freesound account and API credentials at https://freesound.org/apiv2/apply.
   Leave the callback URL at its default, so Freesound shows the login code on a page.
2. Save the credentials **in your own terminal** (not in a chat or shared log):

   ```bash
   mkdir -p ~/.config/freesound && chmod 700 ~/.config/freesound
   pbpaste > ~/.config/freesound/client_id       # copy the client id first
   pbpaste > ~/.config/freesound/client_secret   # then the client secret (Freesound's "API key")
   chmod 600 ~/.config/freesound/*
   ```

   Or set `FREESOUND_CLIENT_ID` and `FREESOUND_CLIENT_SECRET`.

3. Log in: `pnpm test-samples auth` prints a link. Open it, authorize, then run
   `pnpm test-samples auth <code>` with the code Freesound shows (valid ~10 minutes). The token is saved to
   `~/.config/freesound/token.json` and refreshed automatically. Downloading original files needs this
   OAuth login; an API key alone only gets lossy previews.

## Build

```bash
pnpm test-samples                          # edge-cases/ + varied/
pnpm test-samples --bulk 500               # also fill bulk/ with 500 copies
pnpm test-samples --user-library <path>    # non-default User Library
pnpm test-samples --force                  # rewrite everything
```

The default User Library is `~/Music/Ableton/User Library` on macOS and
`~/Documents/Ableton/User Library` on Windows (Live: Settings → Library). Elsewhere, pass `--user-library`.

The first run downloads ~150 sounds (~210 MB). It is rate-limited to Freesound's limits (30 downloads a
minute), so it takes about 6 minutes. Every file is checked against its sha256 in `manifest.json`; a file
that doesn't match is not written and the run fails. Re-runs only download what is missing or changed, so a
complete set needs no network or login. Files in `varied/` that the manifest doesn't list are reported, not
deleted.

Needs Node 22.18+ (it runs the TypeScript directly) and `ffmpeg` on PATH (or `FFMPEG=/path/to/ffmpeg`), for
`edge-cases/`.

## File names in varied/

- ~35 % of the sounds get a bad generic name (`smpl_297.wav`, `New Recording 86.wav`, …). Whether a sound
  gets one, and which, depends only on its Freesound id.
- The rest keep their Freesound name, made safe for file systems (ASCII only, no `/ \ : * ? " < > |`).
- A clash (ignoring case) gets ` 2`, ` 3`, … before the extension.

`samples.json` maps every file to its id, category and original name: the ground truth for the benchmark
(S5), whether or not the file got a bad name. It is generated locally and never committed, because it holds
Freesound metadata. Benchmark queries should refer to sounds by Freesound id.

## Changing the set (maintainer)

`manifest.json` holds only ids, categories and sha256s:

```json
{
  "folder": "Samples/Sample Seeker Test",
  "samples": [{ "id": 12345, "category": "kick", "sha256": "…" }]
}
```

Categories: kick, snare, clap, hihat, cymbal, tom, perc, drum-loop, bass, keys, synth, instrument, stab,
vocal, fx, music-loop, texture.

1. Add or replace entries with `{ "id", "category" }`. Only CC0 sounds that pass the screening (no ripped
   or film/TV/game audio, no brands, no intelligible speech, uploader hasn't opted out of AI use). The
   curation notes and reserve candidates from the first round are in `.cache/test-samples/curation/`
   (local only).
2. Run `pnpm test-samples`, listen to the new sounds (e.g. in Live), and drop any that fail.
3. Run `pnpm test-samples --update-manifest` to pin the sha256 of the new entries, and commit
   `manifest.json`.

If a run reports a sound as "no longer on Freesound" or "no longer CC0", replace it the same way.

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

- **CC0 only.** Every sound is Freesound CC0 (public domain); the build rejects a sound that no longer is.
- **Never publish the set.** No zip, release or other mirror: each developer downloads it through the API
  with their own account, which the API terms allow; re-hosting it would break §4(a).
- **No audio in the repo.** `.gitignore` blocks audio files repo-wide. The repo holds only Freesound ids.
- **No Ableton content.** Its EULA forbids redistributing it (§5(3)), and every machine has a different
  library, so the set wouldn't be the same everywhere.
