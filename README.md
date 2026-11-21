# Sample Seeker

Search your local samples with natural language, and get suggestions for
whatever's selected in Ableton Live.

This is a **scaffold**: build setup, process wiring and stubs. The search
and analysis logic is yours to write (look for `TODO`).

## Layout

```
packages/
  core/        engine library + dev CLI (Node, no Electron)
    src/engine.ts   ← entry point: index(), search(), similar()   [TODO]
    src/embed.ts    ← CLAP audio/text embeddings                  [TODO]
    src/decode.ts   ← audio → Float32Array via ffmpeg              [TODO]
    src/db.ts       ← SQLite + sqlite-vec, schema
    src/cli.ts      ← `sf add|index|search|similar`
  desktop/     Electron app
    src/main.ts           window, IPC, DAW adapter, drag-out
    src/engine-process.ts utility process that owns the Engine (keeps UI responsive)
    src/preload.ts        the renderer's API (window.sf)
    src/daw/types.ts      DawAdapter interface + DawState
    src/daw/ableton-osc.ts  Ableton via AbletonOSC (tempo done; key/selection TODO)
    renderer/             plain HTML/TS UI                          [TODO]
```

How the pieces talk to each other:

```
Live ◄─OSC/UDP 11000/11001─► AbletonOscAdapter (in main.ts)
renderer ◄─IPC─► main.ts ◄─RPC─► engine-process.ts ─► core Engine ─► SQLite
```

## Setup

```bash
pnpm install
pnpm rebuild:electron   # compile better-sqlite3 for Electron's Node ABI
pnpm start              # builds core + desktop, launches the app
```

For the CLI, `pnpm sf search "dusty piano"` runs it with Electron's
Node, so you don't have to rebuild the native module back and forth.

> Linux only: if `pnpm install` fails while onnxruntime-node fetches CUDA
> binaries, prefix it with `ONNXRUNTIME_NODE_INSTALL_CUDA=skip`.

## Development

All tooling is set up once at the repo root and shared by every package.

| Command           | What it does                                             |
| ----------------- | -------------------------------------------------------- |
| `pnpm check`      | Biome: format, lint and sort imports, fixing what it can |
| `pnpm lint`       | Biome lint only                                          |
| `pnpm format`     | Biome format only                                        |
| `pnpm typecheck`  | `tsc --noEmit` for every package                         |
| `pnpm test`       | Vitest, all packages                                     |
| `pnpm test:watch` | Vitest in watch mode                                     |

Each package also has its own `test`, `test:watch`, `lint`, `check` and
`typecheck` scripts. They use the same root configs but only cover that
package. Run them from the package folder (`cd packages/core && pnpm test`) or
with a filter (`pnpm --filter @sample-seeker/core test`).

- **Config:** `biome.jsonc` and `vitest.config.mts` at the root. Each package
  has a small `vitest.config.mts`, and tests live next to the code as
  `src/**/*.spec.ts`.
- **Tests run inside Electron's Node** (`ELECTRON_RUN_AS_NODE=1`), like
  `pnpm sf`, because better-sqlite3 is compiled for Electron's ABI. Run
  `pnpm rebuild:electron` first.
- **Pre-commit hook:** `pnpm install` installs a Lefthook hook that runs Biome
  on staged files and re-stages its fixes.
- **CI** (`.github/workflows/ci.yml`) runs Biome, build, typecheck and tests on
  every PR.
- **Editor:** install the Biome extension for format-on-save.

## Ableton setup (AbletonOSC)

1. Download AbletonOSC (https://github.com/ideoforms/AbletonOSC), unzip, rename the folder to `AbletonOSC`.
2. Copy it into `User Library/Remote Scripts/` (create the folder if needed):
   - macOS: `~/Music/Ableton/User Library/Remote Scripts`
   - Windows: `\Users\<you>\Documents\Ableton\User Library\Remote Scripts`
3. Restart Live, then Settings → Link, Tempo & MIDI → Control Surface → **AbletonOSC**.

With the app running, changing the tempo in Live should show up in the app's Live bar.

### Other DAWs / your own script

Everything DAW-specific lives behind `DawAdapter` (`src/daw/types.ts`). To support
something else, add a class next to `ableton-osc.ts` and change the one line in
`main.ts` that constructs it. If AbletonOSC lacks something (e.g. Simpler sample
paths, a selected-clip listener), fork it, add a handler in Python, and keep
speaking OSC: the app side barely changes.

## Suggested order

1. `decode.ts`: get PCM out of a file.
2. `embed.ts`: load CLAP, embed one file and one text, check that their cosine similarity makes sense.
3. `Engine.index()`: scan folders, store embeddings.
4. `Engine.search()` / `similar()`: nearest neighbours with `vec_distance_cosine`.
5. `AbletonOscAdapter`: key and selection, then UI: preview playback, results for the Live selection.
6. BPM/key (essentia.js is a good option), filters, ranking.
