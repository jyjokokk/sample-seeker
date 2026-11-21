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
- Run tests with `pnpm test` (all packages) or `pnpm --filter <package> test` (one package). Tests run inside Electron's Node; see the README.

## Decisions and findings

- **Tooling is shared at the repo root (S27).** Biome handles lint and format (`biome.jsonc`) and Vitest handles tests (`vitest.config.mts`, with each package as a project). Every package has its own `test`, `lint`, `check` and `typecheck` scripts that use the root configs. Add new packages the same way instead of giving them their own tool configs.
- **Tests and the CLI run inside Electron's Node** (`ELECTRON_RUN_AS_NODE=1`). better-sqlite3 is compiled for Electron's ABI, so plain `node` or `vitest` can't load it. If a native module fails to load, run `pnpm rebuild:electron`.
- **`desktop` resolves `@sample-seeker/core` through `core/dist`.** That's why desktop's `typecheck` builds core first.
- **Biome crashes on the `.claude` symlink in git worktrees** ("path is expected to be under the root"). That's why `biome.jsonc` force-ignores `**/.claude`.
- **Biome also formats YAML**, including the files in `.github/workflows`. After adding or editing a workflow, run `pnpm check` or CI will fail.
- **Changing `packageManager` in `package.json` also changes `pnpm-lock.yaml`.** Commit both, or CI's `pnpm install --frozen-lockfile` fails.
