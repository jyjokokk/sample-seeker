# Agent instructions

## Task tracking (Trello)

Tasks live on the [Sample Seeker Trello board](https://trello.com/b/YKmqR6fT/sample-seeker). The board's development plan and working agreements are on card S1.

- Every card is named `S{cardnumber} - {name}`, e.g. `S6 - Index sample folders (Engine.index)`. A board automation adds the prefix to new cards.
- Milestones are labels (`M1`–`M4`, `Later`), not part of the title.

### Creating cards

- Every task card gets a **"Definition of done"** checklist: concrete, checkable criteria for when the card is finished. Put them in the checklist, not in the description.
- If the task breaks down into smaller steps, add a **"Subtasks"** checklist with one item per step. Position it before "Definition of done".
- Refer to cards by their ID, `S{cardnumber}` (e.g. `S6`), everywhere: in chat, commit messages and branch names.
  - Commit messages: start with the ID, e.g. `S6: Skip unchanged files when indexing`.
  - Branch names: start with the ID in lowercase, e.g. `s6-index-sample-folders`.
- The card number is also in the card URL: `trello.com/c/<shortLink>/<number>-<slug>`.
- The number stays the same when a card is renamed or moved between lists.
