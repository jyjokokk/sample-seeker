# Agent instructions

## Keeping this file up to date

This file is the project's shared memory, and it should improve as the project does. When you, or the user, make a substantial finding or a design or architectural decision, record it here in the same change. Examples:

- An architectural or design decision, and why it was made. Mention the alternatives that were rejected if that helps.
- A convention or rule the user states. Put it in the section it belongs to.
- A non-obvious finding that would cost the next agent time to rediscover, such as a tool quirk, a constraint, or the root cause of a confusing failure.

How to write entries:

- Keep them short and practical: what's true, why, and what to do about it. Link the Trello card (`S{n}`) or PR where the context lives.
- Put each entry in the section where it applies. If none fits, add it under "Decisions and findings" below.
- Update or remove entries that become outdated rather than adding contradictory ones.
- Don't duplicate what the code, README or git history already says clearly. Point to it instead.
- Mention the update to the user when you make it. The Git rules below still apply to committing it.

## Git

- Don't commit or push unless the user has asked you to, or has instructed you to do so for the current task. If you're unsure, ask first.
- Permission covers only what was asked. A request to commit isn't permission to push, and permission given for one change doesn't carry over to the next.
- When opening a new branch, rebase against `origin/main`
- When about to merge a branch into main, rebase from `origin/main` in case of merge conflicts

## Task tracking (Trello)

Tasks live on the [Sample Seeker Trello board](https://trello.com/b/YKmqR6fT/sample-seeker). The board's development plan and working agreements are on card S1.

- Every card is named `S{cardnumber} - {name}`, e.g. `S6 - Index sample folders (Engine.index)`. A board automation adds the prefix to new cards.
- Milestones are labels (`M1`–`M4`, `Later`), not part of the title.

### Creating cards

- Every task card gets a **"Definition of done"** checklist: concrete, checkable criteria for when the card is finished. Put them in the checklist, not in the description.
- If the task breaks down into smaller steps, add a **"Subtasks"** checklist with one item per step. Position it before "Definition of done".
- Name each subtask `S{cardnumber}-{subtasknumber} {description}`, e.g. `S42-1 Create config`.
  - Number subtasks 1, 2, 3… in the order they're added. Numbers are never reused or renumbered: if a subtask is deleted, its number is simply skipped.
  - When adding a subtask to an existing list, use the next number after the highest one already on the card.
- Refer to cards and subtasks by their ID, `S{cardnumber}` or `S{cardnumber}-{subtasknumber}` (e.g. `S6`, `S42-1`), everywhere: in chat, commit messages and branch names.
  - Commit messages: start with the ID, e.g. `S6: Skip unchanged files when indexing` or `S42-1: Create config`.
  - Branch names: start with the ID in lowercase, e.g. `s6-index-sample-folders` or `s42-1-create-config`. For a subtask, the ID alone (`s42-1`) is enough.
- The card number is also in the card URL: `trello.com/c/<shortLink>/<number>-<slug>`.
- The number stays the same when a card is renamed or moved between lists.

## Tests

- Test files are named `*.spec.ts` and live next to the code they test, e.g. `src/db.ts` → `src/db.spec.ts`.
- Write tests as specs: they describe the behaviour of the code, and they're part of its documentation.
  - `describe` names the unit (module, class or function). Each `it` states one behaviour as a sentence, e.g. `it("skips files that haven't changed since the last index")`. Don't name tests after implementation details, e.g. `it("calls statSync")`.
  - Reading only the `describe`/`it` names should tell someone what the code does, including edge cases and error behaviour.
  - Keep each test focused on one behaviour, with a clear arrange / act / assert flow.
- Run tests with `pnpm test` (all packages) or `pnpm --filter <package> test` (one package).

## Decisions and findings

- **Tooling is shared at the repo root (S27).** Biome handles lint and format (`biome.jsonc`) and Vitest handles tests (`vitest.config.ts`, with each package as a project). Every package has its own `test`, `lint`, `check` and `typecheck` scripts that use the root configs. Add new packages the same way instead of giving them their own tool configs.
- **No native rebuild for Electron (S27).** better-sqlite3 (v13 and later) and onnxruntime-node are built on Node-API, so one binary loads in both plain Node and Electron. ffmpeg-static is a standalone executable. That's why tests and the CLI run on plain Node, and there's no `electron-rebuild` step. Older notes (the scaffold, S2) say better-sqlite3 needs rebuilding for Electron; that was true before v13. If you add a native dependency, check that it uses Node-API before assuming it works in both runtimes.
- **The dev CLI is called `sample-seeker`** (`pnpm sample-seeker <command>`). It used to be called `sf`, which was undocumented. `window.sf` (the renderer API) and `SF_DATA_DIR` still use the old abbreviation.
- **`desktop` resolves `@sample-seeker/core` through `core/dist`.** That's why desktop's `typecheck` builds core first.
- **Biome crashes on the `.claude` symlink in git worktrees** ("path is expected to be under the root"). That's why `biome.jsonc` force-ignores `**/.claude`.
- **Biome also formats YAML**, including the files in `.github/workflows`. After adding or editing a workflow, run `pnpm check` or CI will fail.
- **Changing `packageManager` in `package.json` also changes `pnpm-lock.yaml`.** Commit both, or CI's `pnpm install --frozen-lockfile` fails.
- **Test samples: each developer downloads a CC0 Freesound set (S24).** `pnpm test-samples` downloads the sounds listed in `scripts/test-samples/manifest.json` through the Freesound API with the developer's own credentials, checks each against its sha256 and builds the set in the Ableton User Library. Never publish the set (zip, release, LFS or any mirror): Freesound's API terms forbid re-hosting API content (§4(a)). For the same reason the repo holds only ids, categories and sha256s, not names or other metadata. Ableton content was dropped: its EULA forbids redistribution (§5(3)), and every machine has a different library. Never commit audio (`.gitignore` blocks it). CI has no Freesound login, so tests in CI use generated audio and a fake embedder. Details: `scripts/test-samples/README.md`.
- **Freesound OAuth requires PKCE (S256)**, which its API docs don't mention: without `code_challenge` the authorize step fails with "Access has been denied" (the redirect URL says `PKCE with code_challenge_method=S256 is required`). `scripts/test-samples/freesound.ts` handles it. That page also says "denied" whenever it can't show the code, so check the URL for `error=` before assuming the user clicked Deny.
- **Repo scripts are TypeScript run directly by Node (S24).** The root `package.json` has `"type": "module"`, and scripts under `scripts/` are plain `.ts` files run with `node` (type stripping, Node 22.18+; CI uses 24). Use only erasable syntax (no enums, namespaces or parameter properties) and import with `.ts` extensions. `scripts/tsconfig.json` type-checks them as part of `pnpm typecheck`. The packages stay CommonJS, so their `vitest.config.mts` files keep the `.mts` extension.
