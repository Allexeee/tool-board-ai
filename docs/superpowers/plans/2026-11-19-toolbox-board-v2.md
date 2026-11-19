# Board v2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `toolbox-al` with a single-entity card board: requests and tasks, a scored queue, 1–3-card runs, batch review, git B, and a terminal `now`.

**Architecture:** One SQLite DB (`.board/board.db`) is the source of truth for board state. Small TypeScript core modules implement cards, dependencies, queue, runs, review, git, decisions and terminology. The CLI is the public interface; Git is the source of truth for merge state; `decisions.md` is generated from the DB and `terminology.md` is a live file. The old code is removed only after the new tests pass.

**Tech Stack:** Node 24+, TypeScript run with type stripping (no build), `node:sqlite`, `node:test`, `node:child_process` for git. No external dependencies.

**Spec:** `docs/superpowers/specs/2026-11-19-toolbox-board-design.md`

## Global Constraints

- Node 24 or newer; no `npm install` dependencies; no build step.
- DB lives at `.board/board.db`. Open with WAL, `busy_timeout = 5000`, `foreign_keys = on`. Every write transaction uses `begin immediate`.
- All timestamps are ISO-8601 UTC strings in the DB. "Сегодня" for `now` is the local date.
- Score: `importance` 0–3 × `urgency` 0–3 = 0–9. Ties go after all equal scores.
- `run_size` is 1–3 (default 3); a run may contain 1–3 cards. Lease: 2 hours per run, 30 minutes per shaping.
- Git branches: `main` and `dev`; card branch `card/<ID>` (attempt 1) or `card/<ID>-<attempt>`. Merge with `--no-ff`. Pass `AL_ALLOW=1` to git commands that commit or merge, so an old toolbox-al hook cannot block the new tool. `init` removes the old hook.
- Owner id is `owner`; agents are `developer`, `marketer`, etc. A card's required skill must be in the executor's skills.
- All commands accept `--json`. Exit codes: `0` success, `1` nothing to do / not allowed yet, `2` owner decision needed, `3` input error.
- The old `.toolbox-al` data is not migrated. The old code is deleted in Task 16; git history keeps it.
- Do not use the old `toolbox-al` CLI, skills, or plugin while implementing this plan.

## Review Focus

1. **Double booking.** Two executors starting runs with the same card at the same time: exactly one wins, the other gets a clear error, and the card is never held by two runs. Test in Task 6.
2. **Dirty worktree / scope escape.** `finish` must refuse an unclean worktree or a diff outside `scope`, leave the branch and files untouched, and not merge. Test in Task 9.
3. **Review rejection cascade.** Reopening a card in `review` must return not-started dependents to `waiting` and make `finish` of in-progress dependents fail until the dependency is again `review`/`done`. Test in Task 11.
4. **Release gate.** `release` must block on cards in `dev` that are not `done` and on open `critical` findings, but must not block on `needs_merge=false` review cards or reverted cards. Test in Task 10 and Task 11.
5. **Lease expiry.** An expired run must release its cards, close as `lease_expired`, and leave the branch and worktree intact. Test in Task 6 and Task 7.

---

## Task 1: Skeleton, project init, schema, DB, IDs

**Files:**
- Create: `bin/board.ts`, `board.cmd`
- Create: `src/cli/args.ts`, `src/cli/errors.ts`, `src/cli/output.ts`, `src/cli/commands/init.ts`
- Create: `src/core/types.ts`, `src/core/db.ts`, `src/core/schema.ts`, `src/core/project.ts`, `src/core/clock.ts`, `src/core/events.ts`, `src/core/ids.ts`, `src/core/groups.ts`
- Create: `tests/helpers/board.ts`, `tests/core/project.test.ts`, `tests/core/ids.test.ts`, `tests/core/events.test.ts`, `tests/cli/args.test.ts`
- Modify: `package.json`, `.gitignore`

**Interfaces:**
- `Project { root: string; dbPath: string; docsDir: string; boardDir: string }`
- `openDb(path: string): DatabaseSync`
- `tx<T>(db: DatabaseSync, fn: () => T): T`
- `findProject(startDir: string, env?: NodeJS.ProcessEnv): Project | null`
- `initProject(dir: string): { created: string[]; root: string }`
- `allocateGroupId(db: DatabaseSync, prefix: string): string` → `UI-1`
- `allocateId(db: DatabaseSync, kind: 'run' | 'decision'): string` → `RUN-1` / `D1`
- `appendEvent(db, { type, actor, subject, before?, after?, note? }): void`
- `nowIso(now?: Date): string`, `todayStartIso(now?: Date): string`
- `parseArgs(argv: string[]): ParsedArgs`; helpers `stringFlag`, `boolFlag`, `numberFlag`, `stringsFlag`.

- [ ] **Step 1: Write the failing init/schema test**

`tests/core/project.test.ts`:

```ts
const fixture = makeBoard()
assert.ok(existsSync(join(fixture.root, '.board', 'board.db')))
const tables = fixture.db.prepare(
  "select name from sqlite_master where type = 'table' order by name"
).all().map((row: any) => row.name)
for (const table of ['cards', 'steps', 'refs', 'deps', 'discussion', 'events',
  'runs', 'run_cards', 'decisions', 'reviews', 'executors', 'groups', 'meta']) {
  assert.ok(tables.includes(table), `missing table ${table}`)
}
assert.equal(fixture.db.prepare("select id from executors where id = 'owner'").get()?.id, 'owner')
```

Also test: `findProject` from a nested directory; `initProject` adds `.board/` and `.worktrees/` to `.gitignore`; a pre-commit hook containing the `toolbox-al` marker is removed.

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/core/project.test.ts`
Expected: FAIL because `project.ts`/`makeBoard` do not exist.

- [ ] **Step 3: Implement the DB and project skeleton**

Create `src/core/schema.ts` with the DDL from spec §13 (schema v1). `migrate(db)` creates all tables and sets `meta.schemaVersion = '1'`. `openDb` applies WAL, busy timeout and foreign keys. `tx` follows the old nested-transaction pattern from `src/core/db.ts`.

`src/core/project.ts`:
- `findProject` walks up from `startDir` looking for `.board/board.db`; `BOARD_HOME` overrides. A path inside `.worktrees/<id>` resolves to the containing project root by walking up.
- `initProject` creates `.board/`, `docs/board/`, the DB, the owner executor (`kind=human`, `skills=['owner']`), and appends `.board/` and `.worktrees/` to `.gitignore`.
- `initProject` strips the old `toolbox-al` block from `.git/hooks/pre-commit`; if the hook has no other content, delete the file. Do not install a new hook.

Create `bin/board.ts` by adapting `bin/toolbox-al.ts`: command dispatch, `--help`, `--version`, `--json`, `UserError` handling, exit codes. Add `src/cli/args.ts` with `COMMANDS_WITH_SUB = {card, executor, queue, run, decision, term, command, review}` and the flag set used by the spec's CLI (§12). Unknown flags still throw exit 3. Add `board.cmd` that runs `node "%~dp0bin\board.ts" %*`.

Create `src/cli/commands/init.ts`: `board init [dir]`, prints created paths or JSON.

- [ ] **Step 4: Run the init/schema test to verify it passes**

Run: `node --test tests/core/project.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing ID/event test**

`tests/core/ids.test.ts`:

```ts
const { db } = makeBoard()
assert.equal(allocateGroupId(db, 'UI'), 'UI-1')
assert.equal(allocateGroupId(db, 'UI'), 'UI-2')
assert.equal(allocateGroupId(db, 'IM'), 'IM-1')
assert.equal(allocateId(db, 'run'), 'RUN-1')
assert.equal(allocateId(db, 'decision'), 'D1')
assert.throws(() => allocateGroupId(db, 'ui/tool'), /префикс/)
appendEvent(db, { type: 'card.created', actor: 'developer', subject: 'UI-1', after: { title: 'x' } })
assert.equal(listEvents(db, 'UI-1')[0].type, 'card.created')
```

- [ ] **Step 6: Implement IDs and events**

`src/core/ids.ts`: normalize prefix to uppercase, validate `^[A-Z0-9]{1,8}$`; allocate in `groups` atomically. `allocateId` uses `meta` counters `counter.run` / `counter.decision`. `src/core/events.ts` follows the old `appendEvent`/`listEvents` shape.

- [ ] **Step 7: Run the ID/event test and the CLI args test**

Run: `node --test tests/core/ids.test.ts tests/core/events.test.ts tests/cli/args.test.ts`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add bin/board.ts board.cmd src/cli src/core tests package.json .gitignore
git commit -m "feat: board skeleton, schema and project init"
```

---

## Task 2: Executors and card CRUD

**Files:**
- Create: `src/core/executors.ts`, `src/core/cards.ts`
- Create: `src/cli/commands/executor.ts`, `src/cli/commands/card.ts` (add/list/show/edit only)
- Create: `tests/core/executors.test.ts`, `tests/core/cards.test.ts`, `tests/cli/card-add.test.ts`
- Modify: `tests/helpers/board.ts`

**Interfaces:**
- `Executor { id, kind, skills: string[], runSize, worktree: string | null, lastSeen: string | null }`
- `addExecutor(db, { id, kind, skills, runSize? }): Executor`
- `getExecutor`, `listExecutors`, `updateExecutor(db, { id, patch })`, `removeExecutor(db, id)`
- `NewCardInput { group, title, body?, skill, author }`
- `Card` fields exactly as in spec §3.1.
- `createCard(db, input): Card`
- `getCard(db, id): Card | null`
- `listCards(db, filter?: { phase?, status?, skill?, holder?, group? }): Card[]`
- `CardPatch { title?, body?, skill?, importance?, urgency?, needsMerge?, reviewRequired?, scope?, note? }`
- `editCard(db, { id, actor, patch }): Card`

- [ ] **Step 1: Write the failing executor test**

```ts
const { db } = makeBoard()
addExecutor(db, { id: 'developer', kind: 'agent', skills: ['dev'] })
assert.deepEqual(getExecutor(db, 'developer')!.skills, ['dev'])
assert.equal(getExecutor(db, 'developer')!.runSize, 3)
assert.throws(() => addExecutor(db, { id: 'developer', kind: 'agent', skills: ['dev'] }), /уже/)
assert.throws(() => removeExecutor(db, 'owner'), /owner/)
```

- [ ] **Step 2: Implement executors**

`addExecutor` validates id, kind, non-empty unique skills, run size 1–3. `removeExecutor` refuses `owner`; if the executor holds cards, refuse. `updateExecutor` supports skills/runSize. Seed owner already exists from `initProject`.

- [ ] **Step 3: Write the failing card test**

```ts
const { db } = makeBoard()
addExecutor(db, { id: 'developer', kind: 'agent', skills: ['dev'] })
const first = createCard(db, { group: 'UI', title: 'Форма входа', skill: 'dev', author: 'owner' })
const second = createCard(db, { group: 'UI', title: 'Валидация', skill: 'dev', author: 'owner' })
assert.equal(first.id, 'UI-1')
assert.equal(second.id, 'UI-2')
assert.equal(first.phase, 'request')
assert.equal(first.status, 'new')
const owner = createCard(db, { group: 'OPS', title: 'Создать VK группу', skill: 'owner', author: 'owner' })
assert.equal(owner.status, 'ready')
assert.equal(owner.needsMerge, false)
```

Also test `editCard` before/after submit: title/body/scores change; changing `skill` after submit throws; card show includes body.

- [ ] **Step 4: Implement cards CRUD**

`createCard` allocates the group ID and inserts in one transaction. `skill=owner` creates a task in `ready`, `needs_merge=0`, `review_required=0`; all other cards are `phase=request`, `status=new`, `needs_merge=1`. `editCard` allows fields only while `new`/`shaping`; after submit, `skill` is immutable. `listCards` maps rows to `Card`.

Create `src/cli/commands/executor.ts` (`add`, `list`, `edit`, `remove`) and `card.ts` (`add`, `list`, `show`, `edit`). `card add` requires `--group`, `--title`, `--skill`; `--as` defaults to `owner`. `card show` prints id, title, status, phase, skill, scores, scope, body.

- [ ] **Step 5: Run the tests**

Run: `node --test tests/core/executors.test.ts tests/core/cards.test.ts tests/cli/card-add.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/core/executors.ts src/core/cards.ts src/cli/commands/executor.ts src/cli/commands/card.ts tests
git commit -m "feat: executors and card CRUD"
```

---

## Task 3: Steps, refs and discussion

**Files:**
- Create: `src/core/steps.ts`, `src/core/refs.ts`, `src/core/discussion.ts`
- Create: `src/cli/commands/ask.ts`, `src/cli/commands/answer.ts`
- Modify: `src/cli/commands/card.ts` (step/ref/discussion subcommands, journal)
- Create: `tests/core/steps.test.ts`, `tests/core/refs.test.ts`, `tests/core/discussion.test.ts`, `tests/cli/ask-cli.test.ts`

**Interfaces:**
- `Step { cardId, seq, text, done, doneAt }`
- `addStep(db, { cardId, text }): Step`; `doneStep(db, { cardId, seq, done? })`; `removeStep`; `listSteps`; `stepProgress(db, cardId): { done: number; total: number }`
- `Ref { id, cardId, kind: 'link'|'doc'|'spec', value, title?, createdAt }`
- `addRef`, `removeRef`, `listRefs`
- `Discussion { id, cardId, author, kind: 'question'|'answer'|'comment'|'assumption', text, status, answerTo, createdAt, answeredAt }`
- `ask(db, { cardId, author, text }): Discussion`
- `answer(db, { cardId, actor, questionId, text }): Discussion`
- `listDiscussion`, `openQuestions(db, cardId?): Discussion[]`

- [ ] **Step 1: Write the failing steps/refs test**

```ts
const { db } = makeBoard()
const card = createCard(db, { group: 'UI', title: 'x', skill: 'dev', author: 'owner' })
addStep(db, { cardId: card.id, text: 'Написать форму' })
addStep(db, { cardId: card.id, text: 'Добавить тест' })
assert.deepEqual(stepProgress(db, card.id), { done: 0, total: 2 })
doneStep(db, { cardId: card.id, seq: 1 })
assert.deepEqual(stepProgress(db, card.id), { done: 1, total: 2 })
addRef(db, { cardId: card.id, kind: 'spec', value: 'docs/specs/login.md' })
assert.equal(listRefs(db, card.id)[0].kind, 'spec')
```

- [ ] **Step 2: Implement steps/refs**

`addStep` assigns `max(seq)+1`; `removeStep` deletes; `doneStep` sets `done`/`done_at`. `refs` are simple CRUD. Extend `card show` to print `[x]`/`[ ]` steps, refs and progress.

- [ ] **Step 3: Write the failing discussion test**

```ts
const q = ask(db, { cardId: card.id, author: 'developer', text: 'Нужен ли SSO?' })
assert.equal(openQuestions(db, card.id).length, 1)
const a = answer(db, { cardId: card.id, actor: 'owner', questionId: q.id, text: 'Нет' })
assert.equal(a.kind, 'answer')
assert.equal(openQuestions(db, card.id).length, 0)
```

- [ ] **Step 4: Implement discussion and CLI**

`ask` inserts an open question. `answer` marks the question `answered`, inserts an answer row with `answer_to`, and records `answered_at`. Create `board ask UI-1 "..." --as developer` and `board answer UI-1 "..." --as owner`. Extend `card show` to print the discussion and the event journal (`listEvents`) in chronological order.

- [ ] **Step 5: Run the tests**

Run: `node --test tests/core/steps.test.ts tests/core/refs.test.ts tests/core/discussion.test.ts tests/cli/ask-cli.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/core/steps.ts src/core/refs.ts src/core/discussion.ts src/cli/commands/ask.ts src/cli/commands/answer.ts src/cli/commands/card.ts tests
git commit -m "feat: card steps, refs, discussion and journal"
```

---

## Task 4: Dependencies and readiness

**Files:**
- Create: `src/core/deps.ts`
- Modify: `src/cli/commands/card.ts` (dep subcommands)
- Create: `tests/core/deps.test.ts`

**Interfaces:**
- `addDep(db, from: string, to: string): void`
- `removeDep(db, from: string, to: string): void`
- `listDeps(db, id: string): string[]`
- `wouldCycle(db, from: string, to: string): string[] | null`
- `isSatisfied(db, id: string): boolean`
- `refreshReadiness(db): number`

- [ ] **Step 1: Write the failing dependency test**

```ts
const { db } = makeBoard()
const a = seedCard(db, { status: 'done', phase: 'task' })
const b = seedCard(db, { status: 'waiting', phase: 'task' })
addDep(db, b.id, a.id)
refreshReadiness(db)
assert.equal(getCard(db, b.id)!.status, 'ready')

const c = seedCard(db, { status: 'waiting', phase: 'task' })
addDep(db, c.id, b.id)
assert.throws(() => addDep(db, b.id, c.id), /цикл/)
```

Also test: `review` satisfies a dependency; `cancelled` without `waive_deps` does not; `cancelled` with `waive_deps=1` does. The review reopen cascade is Task 11.

- [ ] **Step 2: Implement dependencies**

`addDep` checks both cards exist, rejects self/cycles with a path, inserts. `isSatisfied` returns true for `review`/`done`, and for `cancelled` only when `waive_deps=1`. `refreshReadiness` updates only `phase=task` cards currently `waiting` or `ready`: `waiting` if any dep unsatisfied, `ready` otherwise. Record an event on changes. Extend `card dep add/remove/list` and `card show`.

- [ ] **Step 3: Run the test and commit**

Run: `node --test tests/core/deps.test.ts`
Expected: PASS.

```bash
git add src/core/deps.ts src/cli/commands/card.ts tests
git commit -m "feat: card dependencies and readiness"
```

---

## Task 5: Queue

**Files:**
- Create: `src/core/queue.ts`
- Create: `src/cli/commands/queue.ts`
- Create: `tests/core/queue.test.ts`

**Interfaces:**
- `score(card: Card): number`
- `insertIntoQueue(db, cardId: string): void`
- `moveCard(db, id: string, target: { before?: string; top?: boolean; bottom?: boolean }): void`
- `reorderQueue(db): void`
- `listQueue(db, filter?: { status?: Status[]; group?: string; skill?: string; holder?: string; limit?: number }): Card[]`

- [ ] **Step 1: Write the failing queue test**

```ts
const { db } = makeBoard()
const low = seedCard(db, { phase: 'task', status: 'ready', importance: 1, urgency: 1 })   // 1
const high = seedCard(db, { phase: 'task', status: 'ready', importance: 3, urgency: 3 })  // 9
const mid = seedCard(db, { phase: 'task', status: 'ready', importance: 2, urgency: 2 })   // 4
insertIntoQueue(db, low.id); insertIntoQueue(db, high.id); insertIntoQueue(db, mid.id)
assert.deepEqual(listQueue(db).map((c) => c.id), [high.id, mid.id, low.id])
assert.equal(score(high), 9)
assert.equal(score(seedCard(db, { phase: 'task', status: 'ready', importance: 0, urgency: 3 })), 0)
```

Test: equal scores keep insertion order (new goes after equals); `moveCard(top/bottom/before)`; `reorderQueue` sorts by score and keeps current order within equal scores.

- [ ] **Step 2: Implement queue**

`insertIntoQueue` only accepts `phase=task` cards with `status` `waiting`/`ready`; it inserts after the last card with score >= new score, then renumbers all positions. `moveCard` removes the card and reinserts at the target; `reorderQueue` stable-sorts by score desc and current position asc, then renumbers. `listQueue` returns the queue-visible statuses in position order.

- [ ] **Step 3: Add the CLI and run the test**

`board queue move UI-4 --before UI-2|--top|--bottom`, `board queue reorder`.

Run: `node --test tests/core/queue.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/core/queue.ts src/cli/commands/queue.ts tests
git commit -m "feat: scored card queue"
```

---

## Task 6: Runs, booking and suggestions

**Files:**
- Create: `src/core/runs.ts`
- Create: `src/cli/commands/run.ts`
- Create: `tests/core/runs.test.ts`, `tests/cli/run-cli.test.ts`
- Modify: `tests/helpers/board.ts` (`seedExecutor`, `seedCard`, `seedRun`)

**Interfaces:**
- `Run { id, executorId, status: 'active'|'ended'|'cancelled'|'lease_expired', createdAt, startedAt, endedAt, leaseUntil, review, note }`
- `RunSuggestion { executorId: string; cards: Card[]; group: string | null }`
- `suggestRuns(db, executorId: string, count = 3): RunSuggestion[]`
- `startRun(db, { executorId, cardIds, actor }): Run`
- `addToRun(db, { executorId, cardId, actor }): void`
- `dropFromRun(db, { executorId, cardId, actor }): void`
- `nextCard(db, { executorId }): Card | null`
- `endRun(db, { executorId, actor, review? }): Run`
- `releaseRun(db, { runId, actor, reason }): Run`
- `reclaimExpired(db, now?: Date): number`
- `getActiveRun(db, executorId): Run | null`

- [ ] **Step 1: Write the failing suggestion/booking test**

```ts
// developer has skills ['dev']; cards are UI-1..UI-4, all ready, same group.
const suggested = suggestRuns(db, 'developer', 1)
assert.equal(suggested[0].cards.length, 3)          // up to run_size, not exactly 3
assert.ok(suggested[0].cards.every((c) => c.skill === 'dev'))
const run = startRun(db, { executorId: 'developer', cardIds: suggested[0].cards.map((c) => c.id), actor: 'developer' })
assert.equal(run.status, 'active')
assert.equal(listCards(db, { holder: 'developer' }).length, 3)
assert.throws(() => startRun(db, { executorId: 'developer', cardIds: [suggested[0].cards[0].id], actor: 'developer' }), /активный забег/)
```

Also test: one card is a valid run; more than `run_size` fails; a card with an unmet dependency outside the run fails; a `waiting` card whose dependency is earlier in the same run succeeds; a run ends and releases booked cards; a blocked card stays in `run_cards` and is skipped by `nextCard`.

- [ ] **Step 2: Implement suggestions and booking**

`suggestRuns`: filter by executor skills, `phase=task`, status `ready` (or `waiting` whose unmet deps are all in the candidate run), not held, not booked. Sort by position. Anchor the top card, fill from the same group up to `run_size`, then other groups. Validate dependency order. Return up to `count` disjoint suggestions.

`startRun`: one active run per executor; 1..`run_size` cards; atomic transaction; validate skills/status/availability/deps; allocate `RUN-<n>`; set cards `booked`, `holder`, `run_id`, `lease_until = now + 2h`; insert `run_cards`; append events. `addToRun`/`dropFromRun` operate on the active run. `endRun` refuses if any `run_card` is `in_progress`; releases booked cards to `ready`/`waiting`; drops blocked cards; sets `ended_at` and `review`; clears `run_id`/holder. `reclaimExpired` closes runs past `lease_until` as `lease_expired` and releases cards.

- [ ] **Step 3: Write the failing lease/concurrency tests**

Lease: start a run, set `lease_until` in the past, `reclaimExpired`, assert cards are `ready`/`waiting`, run is `lease_expired`.

Concurrency (two processes): seed a project with one ready card and two executors that both have the `dev` skill (`developer-1`, `developer-2`); spawn two `node bin/board.ts run start --as developer-1 --cards UI-1 --json` and `--as developer-2` processes; assert one exits 0 and one exits non-zero, and the card has exactly one holder.

- [ ] **Step 4: Implement the run CLI and run the tests**

`board run start --as developer --cards UI-1,UI-2,UI-3`, `--suggest 1`; `run add/drop/next/end [--review]/release/list`. `run end --review` sets the flag and prints `board review list` as the next step; it does not wait.

Run: `node --test tests/core/runs.test.ts tests/cli/run-cli.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/runs.ts src/cli/commands/run.ts tests
git commit -m "feat: run booking, suggestions and lease"
```

---

## Task 7: Git primitives

**Files:**
- Create: `src/core/scope.ts`, `src/core/git.ts`
- Create: `tests/helpers/repo.ts`, `tests/core/scope.test.ts`, `tests/core/git.test.ts`

**Interfaces:**
- `runGit(cwd: string, args: string[], env?: Record<string, string>): string`
- `isRepo(root: string): boolean`
- `resolveBranches(root): { main: string; dev: string }`
- `ensureWorktree(root: string, executorId: string): string`
- `startCardBranch(root: string, executorId: string, card: Card): { branch: string; worktree: string }`
- `syncWithDev(root: string, worktree: string, branch: string): void` (merge `dev` into the card branch; on conflict abort and throw)
- `outOfScope(root: string, branch: string, scope: string[]): string[]`
- `mergeToDev(root: string, branch: string, message: string): string` (returns merge commit)
- `isAncestor(root: string, commit: string, ref: string): boolean`
- `mergeCommitFor(root: string, branch: string): string | null`
- `revertMerge(root: string, mergeCommit: string): string`
- `releaseToMain(root: string): string`
- `scopeAllows(path: string, patterns: string[]): boolean`

- [ ] **Step 1: Write the failing scope test**

```ts
assert.equal(scopeAllows('src/a.ts', ['src/**']), true)
assert.equal(scopeAllows('src\\a.ts', ['src/**']), true)
assert.equal(scopeAllows('content/a.md', ['src/**']), false)
assert.equal(scopeAllows('docs/a.md', ['**/*.md']), true)
assert.equal(scopeAllows('src/deep/a.ts', ['src/*']), false)
```

- [ ] **Step 2: Implement scope and the repo helper**

`scopeAllows` normalizes backslashes, strips `./`, supports `**`, `*`, `?`, and treats a pattern without glob chars as an exact file or prefix directory. `tests/helpers/repo.ts` creates a temp repo with `git init -b main`, commits a file, and creates `dev`.

- [ ] **Step 3: Write the failing git test**

```ts
const repo = makeRepo()
const card = seedCard(db, { phase: 'task', status: 'booked', skill: 'dev' })
const wt = ensureWorktree(repo.root, 'developer')
const { branch } = startCardBranch(repo.root, 'developer', card)
writeFileSync(join(wt, 'src', 'a.ts'), 'export const a = 1\n')
runGit(wt, ['add', '.']); runGit(wt, ['commit', '-m', 'UI-1'])
assert.deepEqual(outOfScope(repo.root, branch, ['src/**']), [])
const merge = mergeToDev(repo.root, branch, 'UI-1')
assert.ok(isAncestor(repo.root, merge, 'dev'))
assert.ok(!isAncestor(repo.root, merge, 'main'))
const release = releaseToMain(repo.root)
assert.ok(isAncestor(repo.root, merge, 'main'))
assert.ok(isAncestor(repo.root, release, 'main'))
```

Also test: `startCardBranch` refuses a dirty worktree; `syncWithDev` aborts on conflict and leaves the card branch; `revertMerge` creates a revert commit; `mergeCommitFor` finds the merge.

Lease preservation: create a worktree/branch for a booked card, seed an active run with `lease_until` in the past, call `reclaimExpired(db)`, and assert the card is released, the run is `lease_expired`, and both the worktree directory and the `card/<ID>` branch still exist.

- [ ] **Step 4: Implement git primitives**

Use `execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, AL_ALLOW: '1', ...env } })`. `ensureWorktree` creates `.worktrees/<executor>` with `git worktree add <path> dev`, reuses a registered worktree, and refuses an unregistered directory. `startCardBranch` checks `git status --porcelain` is empty, uses `card/<ID>` or `card/<ID>-<attempt>`, and checks out from `dev`. `syncWithDev` runs `git merge dev` in the worktree; on conflict runs `git merge --abort` and throws with the conflicted files. `mergeToDev` checks the main worktree is clean, checks out `dev`, merges `--no-ff`, records HEAD, and restores the original branch; on conflict aborts and restores. `releaseToMain` does the same from `main` to `dev`.

- [ ] **Step 5: Run the tests and commit**

Run: `node --test tests/core/scope.test.ts tests/core/git.test.ts`
Expected: PASS.

```bash
git add src/core/scope.ts src/core/git.ts tests
git commit -m "feat: git worktrees, branches, scope and merges"
```

---

## Task 8: Status lifecycle

**Files:**
- Create: `src/core/lifecycle.ts`
- Modify: `src/cli/commands/card.ts` (shape, submit, approve, reject, done, cancel, reopen)
- Create: `tests/core/lifecycle.test.ts`, `tests/core/shape-file.test.ts`

**Interfaces:**
- `shapeCard(db, { id, actor }): Card`
- `submitCard(db, { id, actor }): Card`
- `approveCard(db, { id, actor }): Card`
- `rejectCard(db, { id, actor, reason }): Card`
- `ownerDone(db, { id, actor, summary }): Card`
- `blockCard(db, { id, actor, reason, note }): Card`
- `cancelCard(db, { id, actor, reason, waiveDeps?, root? }): Card`
- `reopenCard(db, { id, actor, reason }): Card`
- `applyShapeFile(db, { id, actor, file }): { card: Card; newCards: Card[] }`

- [ ] **Step 1: Write the failing lifecycle test**

```ts
const card = createCard(db, { group: 'UI', title: 'x', skill: 'dev', author: 'owner' })
assert.throws(() => approveCard(db, { id: card.id, actor: 'owner' }), /approval/)
shapeCard(db, { id: card.id, actor: 'developer' })
editCard(db, { id: card.id, actor: 'developer', patch: { importance: 2, urgency: 3, scope: ['src/**'] } })
submitCard(db, { id: card.id, actor: 'developer' })
assert.equal(getCard(db, card.id)!.status, 'approval')
approveCard(db, { id: card.id, actor: 'owner' })
assert.equal(getCard(db, card.id)!.status, 'ready')
assert.throws(() => blockCard(db, { id: card.id, actor: 'developer', reason: '', note: '' }), /причина/)
```

Also test: reject returns to `new`; owner card `done` works without booking; `reopen` increments attempt and clears `previous_holder`; events record actor/reason.

- [ ] **Step 2: Implement the status lifecycle**

`shapeCard`: only `new`, sets `shaping`, holder, 30-minute lease. `submitCard`: only holder, sets phase `task`, status `approval`, validates skill/scores/scope for `needs_merge`; `approveCard` inserts into queue and calls `refreshReadiness`; `rejectCard` returns to `new` with reason; `ownerDone` only `skill=owner`/`ready`, sets `done`, `done_at`, `summary`; `blockCard` requires reason, sets `blocked`, clears holder; `cancelCard` requires reason, sets `cancelled`, optional `waive_deps`; `reopenCard` requires reason, sets `ready`, `attempt++`, clears `reverted_at`, `previous_holder`, moves to queue top. Every change appends an event. The CLI `card shape/submit/approve/reject/done/cancel/reopen` calls these functions.

- [ ] **Step 3: Write the failing `--from` test**

```ts
const card = createCard(db, { group: 'UI', title: 'x', skill: 'dev', author: 'owner' })
shapeCard(db, { id: card.id, actor: 'developer' })
const result = applyShapeFile(db, { id: card.id, actor: 'developer', file: planJson })
assert.equal(getCard(db, card.id)!.importance, 3)
assert.equal(listSteps(db, card.id).length, 2)
assert.equal(result.newCards.length, 1)
assert.equal(getCard(db, result.newCards[0].id)!.phase, 'request')
assert.deepEqual(listDeps(db, card.id), [result.newCards[0].id])
```

`planJson` is the JSON from spec §10.1: `body`, `skill`, `importance`, `urgency`, `needs_merge`, `review_required`, `scope`, `steps`, `refs`, `deps`, `new_cards`, `new_deps`. Invalid JSON or a missing group must leave the card unchanged.

- [ ] **Step 4: Implement `--from`**

`applyShapeFile` parses the file at the CLI layer and calls core functions in one transaction: apply card fields, add steps/refs, resolve `deps` by ID, create `new_cards` as requests, resolve `new_deps` by local `key`, then return the card and created cards. No partial write on error.

- [ ] **Step 5: Run the tests and commit**

Run: `node --test tests/core/lifecycle.test.ts tests/core/shape-file.test.ts`
Expected: PASS.

```bash
git add src/core/lifecycle.ts src/cli/commands/card.ts tests
git commit -m "feat: card status lifecycle and JSON shaping"
```

---

## Task 9: Take, finish and block

**Files:**
- Modify: `src/core/lifecycle.ts`
- Create: `src/cli/commands/take.ts`, `src/cli/commands/finish.ts`, `src/cli/commands/block.ts`, `src/cli/commands/touch.ts`
- Modify: `src/cli/commands/ask.ts` (`--block`)
- Create: `tests/core/take-finish.test.ts`, `tests/cli/take-cli.test.ts`

**Interfaces:**
- `takeCard(db, { id, actor, root }): Card`
- `finishCard(db, { id, actor, summary, root, noMerge? }): Card`
- `touchCard(db, { id, actor }): Card`

- [ ] **Step 1: Write the failing take/finish test**

Use a temp repo and a ready task card. `startRun` with the card; `takeCard` creates the worktree/branch and sets `in_progress`; commit a `src` change; `finishCard` merges to dev and sets `done`/`review`; assert `inDev` and `mergeCommit`.

```ts
const wt = join(root, '.worktrees', 'developer')
writeFileSync(join(wt, 'dirty.txt'), 'x')
assert.throws(() => finishCard(db, { id: card.id, actor: 'developer', summary: 'x', root }), /грязн/)
rmSync(join(wt, 'dirty.txt'))
```

Scope test: commit a file under `docs/` for a card with `scope: ['src/**']`; `finish` throws and does not merge.

Review-opens-deps test: a dependent card is `waiting` on the card being finished with `review_required=true`; after `finish`, the dependency is `review` and the dependent becomes `ready`.

- [ ] **Step 2: Implement take/finish and the CLI**

`takeCard`: validate the card is `booked`/holder, deps satisfied, run active; `ensureWorktree` + `startCardBranch`; set `in_progress`, extend lease; event. `finishCard`: holder check; for `needs_merge`, check clean, `syncWithDev`, `outOfScope`, `mergeToDev`, record `merge_commit`, refresh `in_dev`; set `review` if `review_required` else `done`; set `done_at`/`summary`; `refreshReadiness`; update `run_cards` status; event. `needs_merge=false` skips git. `--no-merge` still checks clean/scope and requires the branch merge commit to be an ancestor of `dev`; record it.

`block` CLI calls `blockCard`; `ask --block` calls `ask` then `blockCard` with reason `needs_decision`. `touchCard` extends the card's run lease to `now + 2h` and appends an event; `board touch UI-1 --as developer`.

- [ ] **Step 3: Run the tests and commit**

Run: `node --test tests/core/take-finish.test.ts tests/cli/take-cli.test.ts`
Expected: PASS.

```bash
git add src/core/lifecycle.ts src/cli/commands/take.ts src/cli/commands/finish.ts src/cli/commands/block.ts src/cli/commands/touch.ts src/cli/commands/ask.ts tests
git commit -m "feat: take, finish, touch, block and scope checks"
```

---

## Task 10: Release, revert and merge state

**Files:**
- Create: `src/core/release.ts`
- Modify: `src/core/git.ts` (`refreshMergeState`), `src/core/lifecycle.ts` (`cancelCard` revert)
- Create: `src/cli/commands/release.ts`
- Create: `tests/core/release.test.ts`

**Interfaces:**
- `refreshMergeState(db, root, card): Card`
- `revertMerge(root, mergeCommit): string`
- `release(db, root, actor): { commit: string; cards: Card[] }`
- `cancelCard` with `root` calls `revertMerge` for cards with `merge_commit` and `in_dev`, sets `reverted_at`/`revert_commit`.

- [ ] **Step 1: Write the failing release test**

```ts
// card A is done + in dev; card B is review + in dev.
assert.throws(() => release(db, root, 'owner'), /review|не done/)
setCardStatus(db, B.id, 'done')
assert.equal(release(db, root, 'owner').commit.length, 40)
assert.equal(getCard(db, A.id)!.inMain, true)
```

Test: a `needs_merge=false` card in `review` does not block; a `severity=critical` card open blocks; a `reverted_at` card does not block; `revertMerge` on a done card sets `reverted_at` and release proceeds; `in_main` is refreshed.

- [ ] **Step 2: Implement merge state and release**

`refreshMergeState` reads `merge_commit` and calls `isAncestor(..., 'dev')`/`isAncestor(..., 'main')`; updates the card. `release` checks:
- no card with `in_dev=true`, `status != 'done'`, `reverted_at is null`;
- no open card with `severity='critical'`;
then `releaseToMain`, refreshes `in_main` for all cards with a merge commit, appends an event. `cancelCard` with root: if the card has `merge_commit` and is in dev, `revertMerge`, set `reverted_at`/`revert_commit`. On conflict, leave the card unchanged and throw.

- [ ] **Step 3: Add the CLI and run the tests**

`board release` prints the merge commit and the released cards; `--json` returns them. `board card cancel UI-1 --reason ...` uses the revert path when `root` is available.

Run: `node --test tests/core/release.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/core/release.ts src/core/git.ts src/core/lifecycle.ts src/cli/commands/release.ts tests
git commit -m "feat: release gate, revert and in_main state"
```

---

## Task 11: Review and findings

**Files:**
- Create: `src/core/review.ts`
- Create: `src/cli/commands/review.ts`
- Modify: `src/cli/commands/card.ts` (`verdict` subcommand)
- Create: `tests/core/review.test.ts`

**Interfaces:**
- `FindingInput { severity: 'critical'|'important'|'other'; text: string; skill?: string; scope?: string[] }`
- `listReviewCards(db): Card[]`
- `addFinding(db, { cardId, reviewer, severity, text, skill?, scope? }): Card`
- `submitVerdict(db, { cardId, reviewer, verdict: 'done'|'reopen', note, findings?: FindingInput[] }): { card: Card; findings: Card[] }`
- `revalidateDependents(db, cardId): number`

- [ ] **Step 1: Write the failing review test**

```ts
const card = seedCard(db, { phase: 'task', status: 'review', needs_merge: true })
const result = submitVerdict(db, {
  cardId: card.id, reviewer: 'reviewer-1', verdict: 'reopen', note: 'нет теста',
  findings: [{ severity: 'critical', text: 'нет теста на отказ' }],
})
assert.equal(result.card.status, 'ready')
assert.equal(result.findings[0].severity, 'critical')
assert.equal(result.findings[0].originCardId, card.id)
assert.throws(() => release(db, root, 'owner'), /critical/)
```

Test: `done` with `important`/`other` findings does not block release; critical findings do; `reopen` makes not-started dependents `waiting` and removes booked dependents from their run; `finish` of an in-progress dependent fails until the dependency is `review`/`done`.

- [ ] **Step 2: Implement review**

`submitVerdict` in one transaction: creates finding cards (`phase=request`, `status=new`, same group, `severity`, `origin_card_id`, inherited `skill`/`needs_merge`/`scope`), inserts a `reviews` row, and for `done` sets the card `done`; for `reopen` sets `ready`, `previous_holder`, `attempt` unchanged, queue top, and adds dependencies from the reviewed card to critical findings. `addFinding` creates one finding card. Finding cards are requests; they still need shaping/approval. `revalidateDependents`: not-started -> `waiting`; booked -> `waiting` and remove from `run_cards`; in-progress -> leave, but `finishCard` checks deps and refuses.

- [ ] **Step 3: Add the review CLI and run the tests**

`board review list [--json]`, `board review finding UI-1 --severity critical --text "..."`, `board review submit UI-1 --verdict done|reopen --note "..." --findings findings.json --reviewer reviewer-1`, and `board card verdict UI-1 --done|--reopen --note "..." --as reviewer-1` (the per-card shortcut, no findings).

Run: `node --test tests/core/review.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/core/review.ts src/cli/commands/review.ts tests
git commit -m "feat: batch review, findings and reopen cascade"
```

---

## Task 12: Decisions and terminology

**Files:**
- Create: `src/core/decisions.ts`, `src/core/terminology.ts`, `src/core/lock.ts`
- Create: `src/cli/commands/decision.ts`, `src/cli/commands/term.ts`, `src/cli/commands/command.ts`
- Create: `tests/core/decisions.test.ts`, `tests/core/terminology.test.ts`

**Interfaces:**
- `addDecision(db, { cardId?, kind, text, author }): Decision`
- `supersedeDecision(db, { id, by, reason, actor }): Decision`
- `obsoleteDecision(db, { id, reason, actor }): Decision`
- `renderDecisions(db, docsDir: string): string`
- `ensureTerminology(root: string): void`
- `addTerm(root, { term, definition, example?, author }): { added: boolean; duplicate: boolean }`
- `listTerms(root): Term[]`; `showTerm(root, term): Term | null`
- `addOwnerCommand(root, { command, action, author }): { added: boolean; duplicate: boolean }`
- `listOwnerCommands(root): OwnerCommand[]`
- `withFileLock(lockPath: string, fn: () => T): T`

- [ ] **Step 1: Write the failing decisions test**

```ts
const d1 = addDecision(db, { cardId: card.id, kind: 'decision', text: 'VK API', author: 'developer' })
const d2 = addDecision(db, { cardId: card.id, kind: 'decision', text: 'VK закрыт', author: 'owner' })
supersedeDecision(db, { id: d1.id, by: d2.id, reason: 'нет доступа', actor: 'owner' })
renderDecisions(db, docs)
const md = readFileSync(join(docs, 'decisions.md'), 'utf8')
assert.match(md, /VK API/)
assert.match(md, /~~/)
assert.ok(md.indexOf('VK закрыт') < md.indexOf('VK API'), 'actual first, inactive last')
```

- [ ] **Step 2: Implement decisions**

DB table `decisions`; `addDecision` allocates `D<n>`; `supersede` sets the old `status=cancelled`, `superseded_by`; `obsolete` sets `irrelevant`. `renderDecisions` writes active entries first, then inactive struck through, atomically (temp + rename). All decision commands re-render.

- [ ] **Step 3: Write the failing terminology test**

```ts
const root = makeBoard().root
ensureTerminology(root)
assert.equal(addTerm(root, { term: 'забег', definition: 'сессия 1–3 карточек', author: 'developer' }).added, true)
assert.equal(addTerm(root, { term: 'забег', definition: 'другое', author: 'marketer' }).duplicate, true)
assert.equal(listTerms(root).length, 2)
assert.throws(() => addOwnerCommand(root, { command: 'RUN', action: 'запуск', author: 'developer' }), /owner/)
addOwnerCommand(root, { command: 'RUN', action: 'запуск забега', author: 'owner' })
assert.equal(listOwnerCommands(root)[0].command, 'RUN')
```

Also test that the existing content of the file is preserved and that the lock prevents a concurrent append (create the lock file, expect a timeout error).

- [ ] **Step 4: Implement terminology and CLI**

`ensureTerminology` creates `docs/board/terminology.md` with the two sections. Reads/writes are line-based: find `## Термины` or `## Команды владельца`, find the table header, append a row after the last row. Preserve all other lines. `withFileLock` uses `openSync(lock, 'wx')`, retries with `Atomics.wait` for up to 2 seconds, then throws. `addOwnerCommand` requires `author === 'owner'`. CLI: `board decision add/list/supersede/obsolete`, `board term add/list/show`, `board command add/list`.

- [ ] **Step 5: Run the tests and commit**

Run: `node --test tests/core/decisions.test.ts tests/core/terminology.test.ts`
Expected: PASS.

```bash
git add src/core/decisions.ts src/core/terminology.ts src/core/lock.ts src/cli/commands/decision.ts src/cli/commands/term.ts src/cli/commands/command.ts tests
git commit -m "feat: decisions journal and terminology document"
```

---

## Task 13: `now` data and tabs

**Files:**
- Create: `src/core/now.ts`, `src/cli/commands/now.ts`
- Create: `tests/core/now.test.ts`, `tests/cli/now-cli.test.ts`

**Interfaces:**
- `NowView { view: 0|1|2|3; header: { doneToday: number; devAhead: number; lastDone: Card[] }; approvals?: Card[]; ownerCards?: Card[]; questions?: Discussion[]; suggestions?: RunSuggestion[]; runs?: Run[]; requests?: Card[]; queue?: Card[]; moreQueue?: number; moreRequests?: number }`
- `nowData(db, { view, executorId, filters, root }): NowView`
- `renderNow(data: NowView): string`

- [ ] **Step 1: Write the failing now test**

```ts
const data = nowData(db, { view: 3, executorId: 'owner', root })
assert.equal(data.header.doneToday, 2)
assert.equal(data.header.devAhead, 1)
assert.equal(data.header.lastDone.length, 5)
assert.equal(data.queue!.length, 15)
assert.equal(data.moreQueue, 2)
assert.ok(data.requests!.every((c) => c.phase === 'request'))
```

Test filters: `--group UI`, `--status ready,blocked`, `--skill dev`, `--mine`; `now 0` has approvals/owner cards/questions; `now 1` suggestions for an executor and three runs for the owner; `now 2` has one suggestion per other executor.

- [ ] **Step 2: Implement now data**

Header: `doneToday` = cards with `status='done'` and local `done_at` today; `devAhead` = `needs_merge=1`, `in_dev=1`, `in_main=0`, `reverted_at is null`; `lastDone` = last 5 `done` by `done_at desc`. View 3: requests (`phase=request`, order created_at) limit 10; queue (`phase=task`, statuses waiting/ready/booked/in_progress/blocked/review, position order) limit 15; `more...` counts. View 0: `approval`, `skill=owner` + `ready`, open questions. View 1: `suggestRuns` for the current executor; if `owner`, one suggestion per agent, up to 3. View 2: active runs plus one suggestion per other executor. Call `reclaimExpired(db)` before reading. Render the sketches from spec §11.

- [ ] **Step 3: Add the CLI and run the tests**

`board now [0|1|2|3] [--group] [--status] [--skill] [--mine] [--phase] [--limit] [--all] [--json]`. Default is `now 3`.

Run: `node --test tests/core/now.test.ts tests/cli/now-cli.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/core/now.ts src/cli/commands/now.ts tests
git commit -m "feat: now tabs and board views"
```

---

## Task 14: Doctor, help and final CLI wiring

**Files:**
- Create: `src/core/doctor.ts`, `src/cli/commands/doctor.ts`
- Modify: `bin/board.ts`, `src/cli/args.ts`, `src/cli/commands/*`
- Create: `tests/core/doctor.test.ts`, `tests/cli/help.test.ts`

**Interfaces:**
- `doctorData(db, root): { errors: string[]; warnings: string[] }`
- `doctor` CLI: exit 0 when clean, 1 on warnings, 3 on errors.

- [ ] **Step 1: Write the failing doctor/help test**

```ts
const data = doctorData(db, root)
assert.deepEqual(data.errors, [])
assert.ok(data.warnings.some((w) => /worktree|lease|review|dev/.test(w)))
const help = runCli(['--help'])
assert.match(help.stdout, /card|run|now/)
assert.equal(runCli(['nope']).status, 3)
```

- [ ] **Step 2: Implement doctor and help**

`doctorData` checks: git repo, `main`/`dev`, `.board/board.db`, owner executor, expired runs, registered tool worktrees that are missing/dirty, cards in dev not `done`, open `critical` findings. `doctor` refreshes merge state for cards with `merge_commit` when git is available. Update `bin/board.ts` help with the full command list from spec §12; `--version` reads `package.json`. Ensure every command module returns an exit code and supports `--json`.

- [ ] **Step 3: Run the tests and commit**

Run: `node --test tests/core/doctor.test.ts tests/cli/help.test.ts`
Expected: PASS.

```bash
git add src/core/doctor.ts src/cli/commands/doctor.ts bin/board.ts src/cli tests
git commit -m "feat: doctor, help and CLI exit codes"
```

---

## Task 15: OpenCode skill, plugin, command and docs

**Files:**
- Create: `src/core/opencode.ts` (templates + `writeOpenCodeFiles(root)`)
- Modify: `src/core/project.ts` (`initProject` calls `writeOpenCodeFiles`)
- Create: `.opencode/skills/board/SKILL.md`, `.opencode/plugins/board/index.ts`, `.opencode/command/review.md`
- Modify: `AGENTS.md`, `README.md`, `package.json`
- Create: `tests/core/opencode.test.ts`

**Interfaces:**
- `writeOpenCodeFiles(root: string): { created: string[] }`
- The plugin tools map to CLI calls: `board_now`, `board_card`, `board_run`, `board_take`, `board_finish`, `board_block`, `board_ask`, `board_answer`, `board_review`, `board_decision`, `board_term`.
- The skill instructs: read `docs/board/terminology.md` at session start and before shaping; use `board now`; shape/approve; take a run; finish with summary; block with reason.
- The command `review.md` runs `board review list --json`, spawns a fresh subagent with the packet, and the subagent calls `board review submit`/`review finding`.

- [ ] **Step 1: Write the failing init/OpenCode test**

```ts
const { created, root } = initProject(temp)
assert.ok(existsSync(join(root, '.opencode', 'skills', 'board', 'SKILL.md')))
assert.ok(existsSync(join(root, '.opencode', 'plugins', 'board', 'index.ts')))
assert.ok(existsSync(join(root, '.opencode', 'command', 'review.md')))
assert.match(readFileSync(join(root, 'AGENTS.md'), 'utf8'), /board/)
assert.ok(created.some((p) => p.includes('SKILL.md')))
```

- [ ] **Step 2: Implement the templates and update docs**

`writeOpenCodeFiles` writes the three files and replaces the `board:begin`/`board:end` block in `AGENTS.md` (create the block if missing). The plugin is thin: resolve `bin/board.ts` (or `BOARD_CLI`), call with `--json`, return stdout/errors. The skill is short; it points to `terminology.md`, `now`, card, run, review, decisions. The command `review.md` uses the OpenCode Task tool to spawn a reviewer and the CLI to submit. Update `README.md` to the new flow; update `package.json` `bin` to `board`, `files`, `scripts.test`. Add the `.board/`, `.worktrees/` gitignore entries.

- [ ] **Step 3: Run the test and commit**

Run: `node --test tests/core/opencode.test.ts`
Expected: PASS.

```bash
git add src/core/opencode.ts src/core/project.ts .opencode AGENTS.md README.md package.json tests
git commit -m "feat: OpenCode skill, plugin and review command"
```

---

## Task 16: Remove old code, acceptance test, final check

**Files:**
- Delete: old `src/core/*` modules not listed in the new structure; old `src/cli/commands/*` not in the new CLI; old `tests/core/*`, `tests/cli/*`, `tests/git/*` not in the new suite; old `.opencode/skills/toolbox-al*`, `.opencode/plugins/toolbox-al`; `bin/toolbox-al.ts`, `toolbox-al.cmd`.
- Move: old specs/research/plans to `docs/archive/` (or delete; git history keeps them).
- Create: `tests/e2e/board.test.ts`
- Modify: `CHANGELOG.md` (v2 entry), `README.md` if needed.

**Interfaces:** none new; this task proves the complete surface.

- [ ] **Step 1: Write the end-to-end test**

`tests/e2e/board.test.ts` uses a temp git repo and the CLI:

```ts
const root = makeRepo()
runCli(['init'], { cwd: root })
runCli(['executor', 'add', 'developer', '--kind', 'agent', '--skills', 'dev'], { cwd: root })
runCli(['card', 'add', '--group', 'UI', '--title', 'Форма', '--skill', 'dev'], { cwd: root })
runCli(['card', 'shape', 'UI-1', '--as', 'owner'], { cwd: root })
runCli(['card', 'edit', 'UI-1', '--importance', '2', '--urgency', '3', '--scope', 'src/**', '--review'], { cwd: root })
runCli(['card', 'submit', 'UI-1', '--as', 'owner'], { cwd: root })
runCli(['card', 'approve', 'UI-1', '--as', 'owner'], { cwd: root })
runCli(['run', 'start', '--as', 'developer', '--cards', 'UI-1'], { cwd: root })
runCli(['take', 'UI-1', '--as', 'developer'], { cwd: root })
// commit a src change in the worktree
runCli(['finish', 'UI-1', '--as', 'developer', '--summary', 'готово'], { cwd: root })
runCli(['run', 'end', '--as', 'developer'], { cwd: root })
assert.match(runCli(['now', '--json'], { cwd: root }).stdout, /dev/)
runCli(['review', 'submit', 'UI-1', '--verdict', 'done', '--reviewer', 'reviewer-1'], { cwd: root })
runCli(['release'], { cwd: root })
```

Also test: owner card `card done` without booking; review with a critical finding blocks release; two concurrent `run start` processes.

- [ ] **Step 2: Delete old code and tests**

Remove every old module and test not used by the new structure. Do not delete `.opencode/agents/` (custom agents are the owner's). Remove the old toolbox-al skill/plugin and the old `bin/toolbox-al.ts`/`toolbox-al.cmd`. Move old specs/plans/research to `docs/archive/` if keeping them; the new spec is `docs/superpowers/specs/2026-11-19-toolbox-board-design.md`.

- [ ] **Step 3: Run the full suite**

Run: `node --test`
Expected: all tests pass, including the new e2e test.

- [ ] **Step 4: Run a manual smoke test**

```bash
node bin/board.ts init /tmp/board-smoke
node bin/board.ts now
node bin/board.ts card add --group UI --title "Проверка" --skill dev
node bin/board.ts card show UI-1
```

Expected: no old-command references; `now` prints the header and the empty queue; `card show` prints the card.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor: replace toolbox-al with the card board"
```

---

## Self-Review Notes

- **Spec coverage:** Tasks 1–5 cover model, IDs, card CRUD, steps/refs/discussion, dependencies and queue. Task 6 covers runs; Task 7 git primitives; Task 8 lifecycle and JSON shaping; Task 9 take/finish; Task 10 release/revert; Task 11 review and findings; Task 12 decisions and terminology; Task 13 `now`; Tasks 14–15 CLI/doctor/OpenCode/docs; Task 16 cleanup and acceptance.
- **Deferred by the spec:** auto-run, web/multi-machine, migration, LFS, release tags/changelog, exact review-finding display, CLI name. These are not missing tasks; they are v1 non-goals or builder calls.
- **Review Focus:** the five lines above are pinned to Tasks 6, 9, 11, 10/11 and 6/7.
- **Type consistency:** `Card`, `Executor`, `Run`, `RunSuggestion`, `FindingInput`, `NowView` are defined once and reused; `score`, `insertIntoQueue`, `refreshReadiness`, `takeCard`, `finishCard`, `release`, `submitVerdict` names are stable across tasks.
