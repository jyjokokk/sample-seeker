# Agent instructions

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
