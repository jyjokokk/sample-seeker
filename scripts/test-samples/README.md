# Test samples (S24)

A known, repeatable sample set for decoding (S3), the CLAP spike (S4), the search benchmark (S5) and
indexing (S6). The audio lives in Ableton's User Library, so Live's browser sees the same files:

```
<User Library>/Samples/Sample Seeker Test/
  varied/      distinct real samples across categories, ~35 % with bad names (benchmark set)
  edge-cases/  one file per format / failure case, generated from synthetic tones and noise
  bulk/        optional copies, only for indexing-speed and incremental-skip tests
```

The default User Library on macOS is `~/Music/Ableton/User Library` (Live: Settings → Library).

## Build

```bash
pnpm test-samples                          # edge-cases/ + varied/
pnpm test-samples --bulk 500               # also fill bulk/ with 500 copies
pnpm test-samples --user-library <path>    # non-default User Library
pnpm test-samples --force                  # rewrite everything
```

Needs `ffmpeg` on PATH (or `FFMPEG=/path/to/ffmpeg`) and Ableton Live installed (its Core Library and the
Build and Drop pack are the sources). Re-running only copies what changed. The run fails if a source file
is missing or two files in `varied/` are identical.

## Files

- `manifest.json`: every `varied/` file: where it comes from (`source` + `path`, or a Freesound `id`),
  its `category`, and its `target` name. When `target` differs from the source file name, it is one of the
  deliberately bad names; the source name is the ground truth for writing `queries.json` (S5).
- `build.mjs`: builds the folder from the manifest.
- `draft-manifest.mjs --total <n>`: drafts the Ableton part of the manifest, balanced across categories.
  Picks and bad names are stable, so raising `--total` keeps earlier entries unchanged. Freesound entries
  are kept as they are. Review the diff before committing.

## Edge cases

| File | What it tests |
| --- | --- |
| `wav-16bit-stereo-44k.wav` | 16-bit WAV, stereo |
| `wav-24bit-mono-48k.wav` | 24-bit WAV, mono, 48 kHz |
| `wav-32float-stereo-96k.wav` | 32-bit float, 96 kHz (resampling) |
| `aiff-16bit-stereo-44k.aif` | AIFF (big-endian PCM) |
| `mp3-stereo-44k.mp3` | MP3 |
| `flac-24bit-mono-48k.flac` | FLAC |
| `long-45s-stereo.wav` | longer than the 30 s decode cap |
| `corrupt.wav` | RIFF/WAVE header followed by garbage; must fail cleanly |
| `empty.wav` | 0 bytes; must fail cleanly |

## Licensing

**Never commit or share the audio.** `.gitignore` blocks audio files repo-wide.

- Ableton content (Core Library, Packs) may not be "resold, sublicensed, or otherwise distributed", and
  isolated samples may not be distributed at all (Ableton EULA §5(3)). Copying them into your own User
  Library for local testing is fine; committing their *names and paths* is fine.
- Freesound: only CC0 sounds. `build.mjs` checks each sound's license through the API and refuses
  anything else. Add entries as
  `{ "source": "freesound", "id": 12345, "category": "vocal", "target": "...", "originalName": "...", "url": "https://freesound.org/s/12345/" }`
  and set `FREESOUND_API_KEY` (https://freesound.org/apiv2/apply). It downloads the HQ MP3 preview,
  since the original files need OAuth.
