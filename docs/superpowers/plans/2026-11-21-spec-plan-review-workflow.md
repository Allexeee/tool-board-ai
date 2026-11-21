# Spec, Plan and Review Workflow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the approved spec/plan workflow: spec review before owner approval, plan written by the executor at `take`, one-cycle run review checking plan and code, reviewer subagents on the default model variant, and findings as backlog/fix-run cards.

**Architecture:** Extend the existing SQLite card model with spec revisions, acceptance criteria and review counters; add a pure review-policy resolver; gate `card submit`/`card approve` on a recorded spec review; snapshot run-review mode at `run start`; make `finish` force review according to that mode; extend `review submit` with plan compliance and a one-reopen cap. OpenCode gets an orchestrator `/review`/`/spec-review`, a read-only `board-reviewer` subagent on the default model variant, and a settings wizard for all modes.

**Tech Stack:** Node 24, TypeScript executed directly, `node:sqlite`, `node:test`, OpenCode Markdown agents/commands and the `@opencode/plugin` API.

**Spec:** `docs/superpowers/specs/2026-11-19-spec-plan-review-workflow-design.md`

## Global Constraints

- Node `>=24`; no external dependencies; tests run with `node --test`.
- SQLite schema moves from v1 to v2 without losing existing cards, runs or reviews.
- Human output stays Russian; every command keeps `--json` and exit codes `0` success, `1` nothing to do, `2` owner decision needed, `3` input error.
- `specReview.mode` defaults to `auto`; `largeSpecChars` defaults to `6000`; `runReview.mode` defaults to `none`.
- `specReview.mode` values: `auto|none|self|subagent`; `runReview.mode` values: `auto|none|self|subagent`.
- Reviewer subagents use `reviewer.model` = `provider/model` **without** `#variant`; `self` uses the main session model.
- Explicit `subagent` with no reviewer model is an error; `auto` with no reviewer model falls back to `self` with a warning.
- `spec_rev` invalidates spec review on any `body`/`acceptance`/`scope` change.
- `review_reopens` counts run-review reopens; one reopen per card; the second non-owner reopen fails with code 2 and leaves the card in `review`.
- `runReview.mode != none` puts every card of the run into `review`; `review_required` still works when the mode is `none`.
- `review submit --plan done|failed` is required; `plan failed` requires verdict `reopen`; `done` with findings is allowed.
- `card verdict` is a deprecated alias of `review submit` with identical gates.
- `run end --review`/`--no-review` override the run mode for that run; `--review` may move already-done run cards into post-hoc review.
- Important/other findings go to backlog; critical findings block `release`; findings are ordinary cards and can form a fix run.
- Existing 297 tests must stay green.

## Review Focus

1. **Stale spec review.** Editing body/acceptance/scope after review, or rejecting/amending a card, must invalidate the review and block submit/approve. Covered by Task 5 and Task 6 tests.
2. **Reviewer inherits Max.** A missing `reviewer.model` must never silently start a subagent on the main Max model. Covered by Task 3 and Task 9 tests.
3. **Endless reopen loop.** A second review reopen must fail with code 2 and leave the card in `review` for the owner; findings must not force another loop. Covered by Task 8 tests.
4. **Coverage mismatch.** Enabling run review must review every card of the run, including `review_required=false`; disabling it must still review `review_required=true` cards. Covered by Task 7 tests.
5. **Legacy bypass.** `card verdict` and `run end --review` must not bypass plan compliance, spec freshness, or the reopen cap. Covered by Task 8 tests.

---

### Task 1: Schema v2 and migration

**Files:**
- Modify: `src/core/schema.ts`
- Test: `tests/core/schema.test.ts` (create)
- Test: `tests/core/doctor.test.ts` (update only if schema-version expectations changed)

**Interfaces:**
- Consumes: current `migrate(db)` and `schemaVersionOf(db)` from `src/core/schema.ts`.
- Produces: `SCHEMA_VERSION = 2`; `migrate(db)` creates v2 for a new database and upgrades v1 in place; returns `2`.

- [ ] **Step 1: Write the failing test**

`tests/core/schema.test.ts`:

```ts
import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { migrate, schemaVersionOf, SCHEMA_VERSION } from '../../src/core/schema.ts'

function columns(db: DatabaseSync, table: string): string[] {
  return (db.prepare(`pragma table_info(${table})`).all() as Array<{ name: string }>).map((r) => r.name)
}

test('новый файл получает схему v2 с полями spec/review', () => {
  const db = new DatabaseSync(':memory:')
  assert.equal(migrate(db), 2)
  assert.equal(SCHEMA_VERSION, 2)
  assert.ok(columns(db, 'cards').includes('acceptance'))
  assert.ok(columns(db, 'cards').includes('spec_rev'))
  assert.ok(columns(db, 'cards').includes('review_reopens'))
  assert.ok(columns(db, 'reviews').includes('kind'))
  assert.ok(columns(db, 'reviews').includes('plan_compliance'))
  assert.ok(columns(db, 'runs').includes('review_mode'))
})

test('база v1 мигрирует без потери карточки', () => {
  const db = new DatabaseSync(':memory:')
  db.exec(`create table meta (key text primary key, value text not null);
    create table cards (id text primary key, body text not null default '', status text not null);
    create table reviews (id integer primary key autoincrement, card_id text not null,
      reviewer text not null, verdict text not null, note text, at text not null);
    create table runs (id text primary key, executor_id text not null, status text not null,
      created_at text not null, started_at text, ended_at text, lease_until text,
      review integer not null default 0, note text);
    insert into meta values ('schemaVersion', '1');
    insert into cards values ('UI-1', 'spec', 'ready');
    insert into reviews (card_id, reviewer, verdict, at) values ('UI-1', 'review', 'done', '2026-01-01');`)
  // The real v1 DDL also has the other tables; this fixture only needs the
  // tables touched by ALTER TABLE for this assertion.
  assert.equal(migrate(db), 2)
  assert.equal(schemaVersionOf(db), 2)
  assert.equal((db.prepare('select count(*) as n from cards').get() as { n: number }).n, 1)
  assert.equal(columns(db, 'cards').includes('spec_rev'), true)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/core/schema.test.ts`
Expected: FAIL because `SCHEMA_VERSION` is 1 and the new columns are absent.

- [ ] **Step 3: Implement schema v2**

In `src/core/schema.ts`:

- Set `export const SCHEMA_VERSION = 2`.
- Add to the `cards` create table: `acceptance text not null default ''`, `spec_rev integer not null default 1`, `review_reopens integer not null default 0`.
- Add to the `runs` create table: `review_mode text`.
- Add to the `reviews` create table: `kind text not null default 'run'`, `mode text`, `spec_rev integer`, `plan_compliance text`.
- Add `MIGRATE_V1_TO_V2` SQL:

```sql
alter table cards add column acceptance text not null default '';
alter table cards add column spec_rev integer not null default 1;
alter table cards add column review_reopens integer not null default 0;
alter table reviews add column kind text not null default 'run';
alter table reviews add column mode text;
alter table reviews add column spec_rev integer;
alter table reviews add column plan_compliance text;
alter table runs add column review_mode text;
```

- Change `migrate`:

```ts
export function migrate(db: DatabaseSync): number {
  const from = schemaVersionOf(db)
  if (from >= SCHEMA_VERSION) return from

  db.exec('begin immediate')
  try {
    if (from === 0) db.exec(DDL)
    else if (from === 1) db.exec(MIGRATE_V1_TO_V2)
    else throw new Error(`нет миграции схемы ${from} → ${SCHEMA_VERSION}`)
    db.prepare(
      "insert into meta (key, value) values ('schemaVersion', ?) " +
        'on conflict(key) do update set value = excluded.value',
    ).run(String(SCHEMA_VERSION))
    db.exec('commit')
  } catch (error) {
    db.exec('rollback')
    throw error
  }
  return SCHEMA_VERSION
}
```

- [ ] **Step 4: Run tests**

Run: `node --test tests/core/schema.test.ts tests/core/doctor.test.ts`
Expected: PASS. If doctor fixtures create a v1 DB with `:memory:` or temp files, update their expected version to 2.

- [ ] **Step 5: Commit**

```bash
git add src/core/schema.ts tests/core/schema.test.ts tests/core/doctor.test.ts
git commit -m "feat: add schema v2 for spec and review workflow"
```

---

### Task 2: Settings v2, setup CLI and wizard

**Files:**
- Modify: `src/core/settings.ts`
- Modify: `src/cli/commands/setup.ts`
- Modify: `src/cli/setup-wizard.ts`
- Modify: `src/cli/commands/init.ts`
- Modify: `src/cli/commands/run.ts` (temporary mode mapping)
- Modify: `src/cli/args.ts`
- Modify: `tests/core/settings.test.ts`
- Modify: `tests/cli/setup-cli.test.ts`
- Modify: `tests/cli/setup-wizard.test.ts`
- Modify: `tests/cli/run-cli.test.ts` (settings flag compatibility)

**Interfaces:**
- Consumes: `readSettings`, `writeSettings`, `ensureSettings`, `updateSettings` from `src/core/settings.ts`.
- Produces:

```ts
export type SpecReviewSetting = 'auto' | 'none' | 'self' | 'subagent'
export type RunReviewSetting = 'auto' | 'none' | 'self' | 'subagent'

export interface BoardSettings {
  version: 2
  reviewer: { model: string | null }
  specReview: { mode: SpecReviewSetting; largeSpecChars: number }
  runReview: { mode: RunReviewSetting }
  setupAt: string | null
}

export const DEFAULT_SETTINGS: BoardSettings
export function updateSettings(
  root: string,
  patch: {
    reviewer?: { model?: string | null }
    specReview?: { mode?: SpecReviewSetting; largeSpecChars?: number }
    runReview?: { mode?: RunReviewSetting }
  },
  now?: () => string,
): BoardSettings
```

- [ ] **Step 1: Write the failing tests**

`tests/core/settings.test.ts` must cover:

- `ensureSettings` creates:

```json
{
  "version": 2,
  "reviewer": { "model": null },
  "specReview": { "mode": "auto", "largeSpecChars": 6000 },
  "runReview": { "mode": "none" },
  "setupAt": null
}
```

- Reading a v1 file migrates it:

```ts
writeFileSync(path, JSON.stringify({ version: 1, reviewAfterRun: true, setupAt: '2026-01-01' }))
assert.equal(readSettings(root).runReview.mode, 'subagent')
assert.equal(readSettings(root).specReview.mode, 'auto')
```

and `reviewAfterRun: false` maps to `runReview.mode: 'none'`.

- `updateSettings` merges nested fields, keeps other fields, and sets `setupAt`.
- Invalid values throw code 3:
  - `specReview.mode === 'sometimes'`
  - `runReview.mode === 'sometimes'`
  - `largeSpecChars === -1`
  - `reviewer.model` containing `#` or missing `/`.
- BOM and corrupt JSON still fall back to defaults.

`tests/cli/setup-cli.test.ts` must cover:

- `board setup --show --json` returns v2 defaults.
- `board setup --spec-review self --large-spec 4000 --run-review subagent --reviewer-model 'opencode-go/deepseek-v4.1-flash' --json` updates all fields.
- `board setup --review-after-run` still works as a deprecated alias for `--run-review subagent`; `--no-review-after-run` maps to `none`.
- `board setup` without TTY prints the terminal hint.
- `init --json` returns `settings`, `setupRequired: true`, and `updated: []`.

`tests/cli/setup-wizard.test.ts` must cover:

- The wizard asks for spec-review mode, large-spec threshold, run-review mode, and reviewer model.
- Answers `self`, `4000`, `subagent`, `opencode-go/deepseek-v4.1-flash` produce the matching settings.
- Empty answers keep defaults.
- Non-TTY does not prompt.

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/core/settings.test.ts tests/cli/setup-cli.test.ts tests/cli/setup-wizard.test.ts tests/cli/run-cli.test.ts`
Expected: FAIL because settings still use `reviewAfterRun` and the CLI flags do not exist.

- [ ] **Step 3: Implement settings v2**

Rewrite `src/core/settings.ts` around the interface above. Keep the atomic temp+rename write and BOM handling. Implement:

- `normalizeSettings(raw: unknown): BoardSettings`:
  - if `raw.version === 1` or `typeof raw.reviewAfterRun === 'boolean'`, migrate:
    `reviewAfterRun === true` → `runReview.mode: 'subagent'`, else `none`;
    `reviewer.model: null`, `specReview: { mode: 'auto', largeSpecChars: 6000 }`.
  - if version 2, validate/normalize each field.
  - unknown/corrupt values fall back to defaults rather than crashing the board.
- `validateReviewerModel(model: string | null): string | null`:
  - `null`/empty → `null`;
  - must match `/^[^/\s#]+\/[^/\s#]+$/` (one slash, no `#`, no spaces);
  - throw `UserError(3, 'reviewer.model — provider/model без #variant')` otherwise.
- `updateSettings` throws `UserError` for invalid values.
- `ensureSettings` writes v2.

- [ ] **Step 4: Implement setup CLI and wizard**

`src/cli/commands/setup.ts`:

- Flags: `--show`, `--reviewer-model <provider/model>`, `--spec-review auto|none|self|subagent`, `--large-spec <n>`, `--run-review auto|none|self|subagent`.
- Deprecated aliases: `--review-after-run` → `runReview.mode='subagent'`; `--no-review-after-run` → `none`. Reject combining a deprecated alias with `--run-review`.
- `--show` prints:

```
Ревью spec: auto (большой spec: 6000 символов)
Ревью в конце забега: none
Модель ревьюера: provider/model (default-вариант)
Мастер настроек: <setupAt | ещё не запускался>
```

- Non-TTY no flags prints the human settings plus `Запустите в терминале: board setup`.
- TTY no flags runs the wizard.

`src/cli/setup-wizard.ts`:

- Keep `shouldRunSetup` but update its `settings` type.
- Ask four questions in order, writing each answer with `updateSettings` only after all answers are valid (or update after each; tests must match).
- Parse:
  - spec mode empty → `auto`; otherwise one of the four values.
  - large spec empty → `6000`; integer `>= 0`.
  - run mode empty → `none`; otherwise one of the four values.
  - reviewer model empty → keep current; otherwise validate.
- Invalid answers re-ask with a short message; do not close the readline early.
- Use `SetupWizardIO` for tests.

`src/cli/commands/init.ts`:

- Use v2 settings.
- `setupRequired = settings.setupAt === null`.
- JSON output `{ root, created, updated, settings, setupRequired }`.
- Human output lists spec mode, run mode, reviewer model, and the setup hint.

`src/cli/commands/run.ts` for now:

- Replace `readSettings(project.root).reviewAfterRun` with `readSettings(project.root).runReview.mode !== 'none'`.
- Keep `--review`/`--no-review` behavior; Task 7 replaces it with modes.
- Update human text to mention the setting rather than a boolean.

`src/cli/args.ts`:

- Add known/boolean flags: `reviewer-model`, `spec-review`, `large-spec`, `run-review` (`large-spec` is a value flag, not boolean).

- [ ] **Step 5: Update existing tests and run**

- `tests/cli/run-cli.test.ts`: the existing `setup --review-after-run` flow must still pass via the deprecated alias; the default is `runReview.mode='none'`.
- `tests/core/settings.test.ts`: replace v1 assertions with v2 + migration.
- `tests/cli/setup-wizard.test.ts`: update prompts and answer sequences.
- `tests/cli/init` expectations: add `setupRequired`/v2 settings.

Run: `node --test tests/core/settings.test.ts tests/cli/setup-cli.test.ts tests/cli/setup-wizard.test.ts tests/cli/run-cli.test.ts tests/core/opencode.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/core/settings.ts src/cli/commands/setup.ts src/cli/setup-wizard.ts src/cli/commands/init.ts src/cli/commands/run.ts src/cli/args.ts tests/core/settings.test.ts tests/cli/setup-cli.test.ts tests/cli/setup-wizard.test.ts tests/cli/run-cli.test.ts
git commit -m "feat: add v2 settings for reviewer modes"
```

---

### Task 3: Review policy resolver and model context

**Files:**
- Create: `src/core/review-policy.ts`
- Test: `tests/core/review-policy.test.ts` (create)

**Interfaces:**
- Consumes: `BoardSettings` from Task 2.
- Produces:

```ts
export type ConcreteSpecMode = 'none' | 'self' | 'subagent'
export type ConcreteRunMode = 'none' | 'self' | 'subagent'

export interface ModelContext {
  variant: string | null
  sessionModel: string | null
}

export interface ReviewResolution {
  mode: ConcreteSpecMode | ConcreteRunMode
  reason: 'explicit' | 'model-max-high' | 'large-spec' | 'default-self' | 'no-reviewer-model'
  reviewerModel: string | null
}

export function modelContext(env?: NodeJS.ProcessEnv): ModelContext
export function effectiveReviewerModel(settings: BoardSettings, context: ModelContext): string | null
export function resolveSpecReviewMode(input: {
  settings: BoardSettings
  specLength: number
  context: ModelContext
}): ReviewResolution
export function resolveRunReviewMode(input: {
  settings: BoardSettings
  context: ModelContext
}): ReviewResolution
```

- [ ] **Step 1: Write the failing test**

`tests/core/review-policy.test.ts`:

```ts
const base: BoardSettings = {
  version: 2,
  reviewer: { model: 'opencode-go/deepseek-v4.1-flash' },
  specReview: { mode: 'auto', largeSpecChars: 6000 },
  runReview: { mode: 'none' },
  setupAt: null,
}

test('auto: max/high → subagent, обычный вариант → self', () => {
  assert.equal(resolveSpecReviewMode({ settings: base, specLength: 10, context: { variant: 'max', sessionModel: null } }).mode, 'subagent')
  assert.equal(resolveSpecReviewMode({ settings: base, specLength: 10, context: { variant: 'high', sessionModel: null } }).mode, 'subagent')
  assert.equal(resolveSpecReviewMode({ settings: base, specLength: 10, context: { variant: 'low', sessionModel: null } }).mode, 'self')
})

test('auto: большой spec → subagent, 0 отключает правило', () => {
  assert.equal(resolveSpecReviewMode({ settings: base, specLength: 6000, context: { variant: null, sessionModel: null } }).mode, 'subagent')
  const off = { ...base, specReview: { mode: 'auto' as const, largeSpecChars: 0 } }
  assert.equal(resolveSpecReviewMode({ settings: off, specLength: 99_999, context: { variant: null, sessionModel: null } }).mode, 'self')
})

test('explicit modes ignore model and size', () => {
  for (const mode of ['none', 'self', 'subagent'] as const) {
    const settings = { ...base, specReview: { mode, largeSpecChars: 1 } }
    assert.equal(resolveSpecReviewMode({ settings, specLength: 999_999, context: { variant: 'max', sessionModel: null } }).mode, mode)
  }
})

test('subagent без модели: явный режим возвращает null, auto падает в self', () => {
  const noModel = { ...base, reviewer: { model: null } }
  const explicit = resolveSpecReviewMode({
    settings: { ...noModel, specReview: { mode: 'subagent', largeSpecChars: 6000 } },
    specLength: 10,
    context: { variant: 'max', sessionModel: null },
  })
  assert.equal(explicit.mode, 'subagent')
  assert.equal(explicit.reviewerModel, null)
  const auto = resolveSpecReviewMode({ settings: noModel, specLength: 10, context: { variant: 'max', sessionModel: null } })
  assert.equal(auto.mode, 'self')
  assert.equal(auto.reason, 'no-reviewer-model')
})

test('effectiveReviewerModel: настройка важнее сессии, вариант срезается', () => {
  assert.equal(effectiveReviewerModel(base, { variant: 'max', sessionModel: 'acme/other#high' }), 'opencode-go/deepseek-v4.1-flash')
  assert.equal(effectiveReviewerModel({ ...base, reviewer: { model: null } }, { variant: 'max', sessionModel: 'acme/other#high' }), 'acme/other')
})

test('modelContext читает env', () => {
  assert.deepEqual(modelContext({ BOARD_MODEL_VARIANT: 'max', BOARD_SESSION_MODEL: 'acme/other' }), {
    variant: 'max',
    sessionModel: 'acme/other',
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/core/review-policy.test.ts`
Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement the resolver**

Rules:

- `effectiveReviewerModel`: `settings.reviewer.model ?? context.sessionModel`; strip `#...`; return `null` for empty.
- `resolveSpecReviewMode`:
  - explicit `none|self|subagent` → that mode, reason `explicit`.
  - `auto`:
    - if `context.variant` lowercased is `max` or `high` → `subagent`, reason `model-max-high`;
    - else if `settings.specReview.largeSpecChars > 0 && specLength >= largeSpecChars` → `subagent`, reason `large-spec`;
    - else if reviewerModel is null → `self`, reason `no-reviewer-model`;
    - else `self`, reason `default-self`.
  - `reviewerModel` always computed; explicit subagent with null model is returned as `mode:'subagent', reviewerModel:null` so callers can error.
- `resolveRunReviewMode`:
  - explicit → that mode.
  - `auto`: max/high → subagent; else if no model → self with `no-reviewer-model`; else self with `default-self`.
- `modelContext`: read `BOARD_MODEL_VARIANT` and `BOARD_SESSION_MODEL`, trim; empty → null.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/core/review-policy.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/review-policy.ts tests/core/review-policy.test.ts
git commit -m "feat: resolve reviewer modes from settings and model variant"
```

---

### Task 4: Spec and acceptance fields, plan at take

**Files:**
- Modify: `src/core/types.ts`
- Modify: `src/core/cards.ts`
- Modify: `src/core/lifecycle.ts`
- Modify: `src/cli/commands/card.ts`
- Modify: `src/cli/args.ts`
- Modify: `tests/helpers/board.ts` (seed defaults if needed)
- Test: `tests/core/cards.test.ts`
- Test: `tests/core/shape-file.test.ts`
- Test: `tests/cli/card-detail.test.ts`
- Test: `tests/cli/card-add.test.ts`
- Test: `tests/core/take-finish.test.ts`

**Interfaces:**
- Consumes: schema v2 columns.
- Produces: `Card.acceptance: string`, `Card.specRev: number`, `Card.reviewReopens: number`; `ShapeFile` accepts `spec?: string`, `acceptance?: string[]`, no `steps`.
- `CardPatch` accepts `acceptance?: string[]` and `body`/`scope`.

- [ ] **Step 1: Write failing tests**

`tests/core/cards.test.ts`:

```ts
test('spec и acceptance сохраняются, spec_rev растёт при правке', () => {
  const card = createCard(db, { group: 'UI', title: 'T', skill: 'dev', author: 'owner', body: 'spec' })
  assert.equal(card.acceptance, '')
  assert.equal(card.specRev, 1)
  const withAcceptance = editCard(db, {
    id: card.id, actor: 'developer', patch: { acceptance: ['первый', 'второй'] },
  })
  assert.equal(withAcceptance.acceptance, 'первый\nвторой')
  assert.equal(withAcceptance.specRev, 2)
  const withScope = editCard(db, {
    id: card.id, actor: 'developer', patch: { scope: ['src/**'] },
  })
  assert.equal(withScope.specRev, 3)
})
```

`tests/core/shape-file.test.ts`:

```ts
test('shape JSON принимает spec/acceptance и не создаёт plan-шаги', () => {
  const card = seedCard(db, { phase: 'request', status: 'new' })
  applyShapeFile(db, { id: card.id, actor: 'developer', file: {
    spec: 'Нужен вход', acceptance: ['Вход работает'], skill: 'dev',
    importance: 2, urgency: 2, needs_merge: false,
  }})
  const updated = getCard(db, card.id)!
  assert.equal(updated.body, 'Нужен вход')
  assert.equal(updated.acceptance, 'Вход работает')
  assert.deepEqual(listSteps(db, card.id), [])
})

test('shape JSON с steps отклоняется: план пишется при take', () => {
  assert.throws(() => applyShapeFile(db, { id, actor: 'developer', file: { steps: ['x'] } as never }),
    (error: { code?: number }) => error.code === 3)
})
```

`tests/cli/card-detail.test.ts`: `card show --json` exposes `acceptance`, `specRev`, and `plan` (alias for steps).

`tests/cli/card-add.test.ts`: `card add --spec "..." --acceptance "..." --acceptance "..."` stores the spec and lines.

`tests/core/take-finish.test.ts`: after `take`, `card step add` works and the plan is visible in `card show`/review package.

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/core/cards.test.ts tests/core/shape-file.test.ts tests/cli/card-detail.test.ts tests/cli/card-add.test.ts tests/core/take-finish.test.ts`
Expected: FAIL because the fields and shape keys do not exist.

- [ ] **Step 3: Implement types and card mapping**

`src/core/types.ts`:

```ts
export interface Card {
  // existing fields ...
  acceptance: string
  specRev: number
  reviewReopens: number
}
```

`src/core/cards.ts`:

- `CardRow`: add `acceptance: string`, `spec_rev: number`, `review_reopens: number`.
- `toCard`: map `acceptance`, `specRev`, `reviewReopens`.
- `NewCardInput`: add `acceptance?: string[]`; `createCard` stores newline-joined acceptance.
- `CardPatch`: add `acceptance?: string[]`.
- `editCard`: when `body`, `acceptance` or `scope` changes, add `spec_rev = spec_rev + 1` to the update. Normalize acceptance with `normalizeAcceptance` (trim lines, drop empties, join `\n`).

- [ ] **Step 4: Implement shape and CLI**

`src/core/lifecycle.ts`:

- `ShapeFile`:
  ```ts
  export interface ShapeFile {
    spec?: string
    body?: string // legacy alias
    acceptance?: string[]
    skill?: string
    importance?: number
    urgency?: number
    needs_merge?: boolean
    review_required?: boolean
    scope?: string[]
    deps?: string[]
    new_cards?: NewCardInput[]
    new_deps?: Array<[string, string]>
  }
  ```
- Remove `steps?: string[]` and the `addStep` loop from `applyShapeFile`.
- If `file.steps !== undefined` (unknown key), throw `UserError(3, 'steps пишутся при take, не при shape')`. Since the type no longer has `steps`, parse the raw JSON in `parseShapeFile` and reject it before casting.
- Body = `file.spec ?? file.body ?? ''`; acceptance from `file.acceptance`.

`src/cli/commands/card.ts`:

- `add`/`edit`: accept `--spec` as alias for `--body`; accept repeated `--acceptance` and map to `patch.acceptance`.
- `show`: add `spec: card.body`, `plan: listSteps(...)`, `acceptance`, `specRev`, `reviewReopens`; keep `body`/`steps` for compatibility.
- `shape` usage text: `--from card.json` with `spec/acceptance`; no steps.
- `formatCard`: print acceptance lines.

`src/cli/args.ts`: add `spec` and `acceptance` flags; `acceptance` is a value flag.

- [ ] **Step 5: Run tests and update fixtures**

Run: `node --test tests/core/cards.test.ts tests/core/shape-file.test.ts tests/cli/card-detail.test.ts tests/cli/card-add.test.ts tests/core/take-finish.test.ts`
Expected: PASS. Update `tests/helpers/board.ts` if `seedCard`/`createCard` inputs need `acceptance`; all defaults should be empty.

- [ ] **Step 6: Commit**

```bash
git add src/core/types.ts src/core/cards.ts src/core/lifecycle.ts src/cli/commands/card.ts src/cli/args.ts tests/core/cards.test.ts tests/core/shape-file.test.ts tests/cli/card-detail.test.ts tests/cli/card-add.test.ts tests/core/take-finish.test.ts tests/helpers/board.ts
git commit -m "feat: separate card spec and plan at take"
```

---

### Task 5: Spec review record and submit/approve gate

**Files:**
- Create: `src/core/spec-review.ts`
- Modify: `src/core/types.ts` (`Review` interface)
- Modify: `src/core/lifecycle.ts` (`submitCard`, `approveCard`)
- Modify: `src/cli/commands/card.ts`
- Modify: `src/cli/args.ts` (`mode` flag)
- Test: `tests/core/spec-review.test.ts` (create)
- Test: `tests/cli/spec-review-cli.test.ts` (create)
- Test: `tests/cli/card-detail.test.ts`
- Test: `tests/cli/card-shape-cli.test.ts`

**Interfaces:**
- Consumes: `Card`, `reviews` v2, `BoardSettings`, `resolveSpecReviewMode`, `modelContext`.
- Produces:

```ts
export interface Review {
  id: number
  cardId: string
  reviewer: string
  verdict: 'done' | 'reopen'
  note: string | null
  at: string
  kind: 'spec' | 'run'
  mode: 'self' | 'subagent' | null
  specRev: number | null
  planCompliance: 'done' | 'failed' | null
}

export interface SpecReviewInput {
  cardId: string
  reviewer: string
  mode: 'self' | 'subagent'
  verdict: 'done' | 'reopen'
  note?: string
}
export interface SpecReviewGate {
  mode: 'none' | 'self' | 'subagent'
  reviewerModel: string | null
}
export function recordSpecReview(db: DatabaseSync, input: SpecReviewInput): Review
export function latestSpecReview(db: DatabaseSync, cardId: string): Review | null
export function assertSpecReview(db: DatabaseSync, card: Card, gate: SpecReviewGate): void
```

- [ ] **Step 1: Write failing tests**

`tests/core/spec-review.test.ts`:

- `recordSpecReview` stores `kind='spec'`, `mode`, `specRev`, `verdict`, `note`.
- It rejects `card.status !== 'shaping'`.
- It rejects empty spec/acceptance.
- `assertSpecReview` with `none` does nothing.
- With `self`: requires latest `done` with current `specRev`; stale review fails code 2.
- With `subagent`: a self review fails code 2; a subagent review passes.
- With `subagent` and `reviewerModel: null` fails code 2.
- `submitCard` with `requiredSpecReview` calls the gate; without a review, it fails.
- `approveCard` with a stale review fails.

`tests/cli/spec-review-cli.test.ts`:

- `board card spec-review UI-1 --as developer --mode self --verdict done --note "..."` returns the review.
- `board card submit` before review fails with code 2; after review passes.
- `board card show --json` includes `specReview: { mode, reason }` and `specReviewLatest`.
- With `BOARD_MODEL_VARIANT=max` and settings `specReview.mode=auto`, `card show` reports `subagent`; `card submit` with a self review fails; with a subagent review passes.
- With no `BOARD_SESSION_MODEL` and explicit `subagent`, `card submit` fails with code 2 and a `--reviewer-model` hint.

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/core/spec-review.test.ts tests/cli/spec-review-cli.test.ts`
Expected: FAIL because the module and command do not exist.

- [ ] **Step 3: Implement the core spec-review module**

`src/core/spec-review.ts`:

- `recordSpecReview` in `tx`:
  - require card; status `shaping`;
  - spec body trim non-empty; acceptance lines non-empty;
  - mode is `self|subagent`;
  - insert `reviews` with `kind='spec'`, `mode`, `spec_rev=card.specRev`, `verdict`, `note`, `at`;
  - append `spec.reviewed` event with mode/verdict.
- `latestSpecReview`: select `* from reviews where card_id=? and kind='spec' order by id desc limit 1`; map to a `Review` type (add `Review` to `types.ts`).
- `assertSpecReview`:
  - `none` → return;
  - `subagent` + no reviewerModel → `UserError(2, 'нужен reviewer.model: board setup --reviewer-model ... или выберите self')`;
  - latest review must exist, `verdict === 'done'`, `specRev === card.specRev`;
  - if gate mode `subagent` and latest mode `self` → `UserError(2, 'spec review требует субагента: ...')`.

- [ ] **Step 4: Gate submit and approve**

`src/core/lifecycle.ts`:

- `submitCard` input add `requiredSpecReview?: SpecReviewGate`; call `assertSpecReview(db, card, input.requiredSpecReview ?? { mode: 'none', reviewerModel: null })` before the transition.
- `approveCard` input add the same; assert before changing status.

`src/cli/commands/card.ts`:

- Add `requireSettings()` helper: `findProject`/`readSettings`.
- `reviewContext` from `modelContext(process.env)`.
- `specReview` subcommand: parse ID, `--as`, `--mode`, `--verdict`, `--note`; call `recordSpecReview`.
- `show`: add `specReview` resolution and `specReviewLatest`.
- `submit`/`approve`: resolve the gate and pass it.
- `mode` flag in `args.ts`.

- [ ] **Step 5: Update existing submit tests**

Because defaults are `specReview.mode='auto'`, existing tests that call `submitCard`/`card submit` without a spec review will fail. Add a test helper in `tests/helpers/board.ts`:

```ts
export function relaxSpecReview(root: string): void {
  updateSettings(root, { specReview: { mode: 'none' } })
}
```

Call it in fixtures/tests that are not about spec review. For CLI tests, run `board setup --spec-review none --json` after `init`, or write the settings file before submit.

- [ ] **Step 6: Run tests and commit**

Run: `node --test tests/core/spec-review.test.ts tests/cli/spec-review-cli.test.ts tests/cli/card-detail.test.ts tests/cli/card-shape-cli.test.ts tests/cli/card-add.test.ts`
Expected: PASS.

```bash
git add src/core/spec-review.ts src/core/lifecycle.ts src/core/types.ts src/cli/commands/card.ts src/cli/args.ts tests/core/spec-review.test.ts tests/cli/spec-review-cli.test.ts tests/helpers/board.ts
git commit -m "feat: gate card submit on spec review"
```

---

### Task 6: Spec revisions, amend and post-approval locks

**Files:**
- Modify: `src/core/cards.ts` (`editCard` lock)
- Modify: `src/core/lifecycle.ts` (`amendCard`, `rejectCard`, `approveCard`)
- Modify: `src/cli/commands/card.ts`
- Modify: `src/cli/args.ts` (`amend` is a card subcommand; no new flag unless `--reason` already exists)
- Test: `tests/core/cards.test.ts`
- Test: `tests/core/lifecycle.test.ts`
- Test: `tests/cli/card-detail.test.ts`
- Test: `tests/cli/spec-review-cli.test.ts`

**Interfaces:**
- Produces: `amendCard(db, { id, actor, reason }): Card`; `editCard` rejects body/acceptance/scope outside `new|shaping`; `rejectCard` increments `spec_rev` and clears `approved_at`; `approveCard` checks the current spec review.

- [ ] **Step 1: Write failing tests**

- Editing `body` in `approval`, `ready`, `waiting`, `blocked`, `in_progress` fails with code 3 and a `card amend` hint.
- Editing `acceptance`/`scope` has the same lock.
- `card reject` increments `spec_rev`; a previously done spec review becomes stale; resubmit requires a new review.
- `card amend` from `approval`/`ready`/`waiting`/`blocked` returns to `shaping`, increments `spec_rev`, clears `approved_at`, sets the actor as holder, and clears queue position.
- `card amend` from `in_progress`/`booked`/`review`/`done` fails with a clear message (block/reopen first).
- After `amend`, `card approve` without a new spec review fails; after `spec-review` + `approve` passes.
- `spec_rev` increments exactly once when multiple spec fields change in one edit.

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/core/cards.test.ts tests/core/lifecycle.test.ts tests/cli/spec-review-cli.test.ts`
Expected: FAIL because edits are still allowed and `amend` is missing.

- [ ] **Step 3: Implement the locks and amend**

`src/core/cards.ts` `editCard`:

- If patch touches `body`, `acceptance`, or `scope` and `card.status` is not `new`/`shaping`, throw `UserError(3, 'spec утверждён: используйте board card amend ...')`.
- If any spec field changes, add `spec_rev = spec_rev + 1` once.

`src/core/lifecycle.ts`:

- `rejectCard`: add `spec_rev = spec_rev + 1, approved_at = null` to the update.
- `amendCard`:
  ```ts
  export function amendCard(db, input: { id: string; actor: string; reason: string }): Card
  ```
  - allowed statuses `approval|ready|waiting|blocked`;
  - set `phase='request'`, `status='shaping'`, `holder=actor`, `lease_until=now+30m`, `approved_at=null`, `spec_rev=spec_rev+1`, `position=null`, `updated_at=now`;
  - append `card.amended` with the reason; add a discussion comment if the project convention requires it (use `comment`).
- `approveCard`: call `assertSpecReview` with the gate before transition if provided.

`src/cli/commands/card.ts`:

- `amend` subcommand: ID, `--as`, `--reason`; call `amendCard`.
- Usage strings include `amend`.
- `approve` resolves the spec gate and passes it.

- [ ] **Step 4: Run tests and commit**

Run: `node --test tests/core/cards.test.ts tests/core/lifecycle.test.ts tests/cli/spec-review-cli.test.ts tests/cli/card-shape-cli.test.ts`
Expected: PASS.

```bash
git add src/core/cards.ts src/core/lifecycle.ts src/cli/commands/card.ts tests/core/cards.test.ts tests/core/lifecycle.test.ts tests/cli/spec-review-cli.test.ts
git commit -m "feat: require re-approval after spec amendments"
```

---

### Task 7: Run review modes, snapshot and coverage

**Files:**
- Modify: `src/core/types.ts` (`Run.reviewMode`, `RunReviewMode`)
- Modify: `src/core/runs.ts` (`startRun`, `endRun`, `closeRun`, `toRun`)
- Modify: `src/core/lifecycle.ts` (`finishCard` forceReview)
- Modify: `src/cli/commands/run.ts`
- Modify: `src/cli/commands/finish.ts`
- Modify: `src/core/review.ts`? only if the review package needs mode
- Test: `tests/core/runs.test.ts`
- Test: `tests/cli/run-cli.test.ts`
- Test: `tests/core/take-finish.test.ts`

**Interfaces:**
- Produces:

```ts
export type RunReviewMode = 'none' | 'self' | 'subagent'
export interface Run { /* ... */ reviewMode: RunReviewMode | null }

startRun(db, input: { executorId; cardIds; actor; reviewMode?: RunReviewMode }): Run
endRun(db, input: { executorId; actor; reviewMode?: RunReviewMode }): Run
finishCard(db, input: FinishInput & { forceReview?: boolean }): Card
```

- [ ] **Step 1: Write failing tests**

- `run start` with settings `runReview.mode='subagent'` and `BOARD_SESSION_MODEL` set stores `run.reviewMode='subagent'`; `run list --json` exposes it.
- `finish` with `review_required=false` and run mode `subagent` puts the card in `review`.
- `finish` with run mode `none` and `review_required=false` puts the card in `done`.
- `finish` with run mode `none` and `review_required=true` puts the card in `review`.
- `run end` with `--no-review` records `reviewMode='none'`; with `--review` records `auto` or the resolved mode.
- `run end --review` after cards are `done` moves them to `review` (post-hoc), sets `run_cards.status='review'`, and keeps `mergeCommit`/`summary`.
- `run end --no-review` does not move done cards; cards already in `review` stay.
- `run end` output includes `reviewMode` and `reviewCards`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/core/runs.test.ts tests/cli/run-cli.test.ts tests/core/take-finish.test.ts`
Expected: FAIL because `reviewMode` and force-review do not exist.

- [ ] **Step 3: Implement run mode storage and finish coverage**

`src/core/types.ts`: add `RunReviewMode` and `Run.reviewMode`.

`src/core/schema.ts`: already has `runs.review_mode` from Task 1.

`src/core/runs.ts`:
- `RunRow` add `review_mode: string | null`; `toRun` map.
- `startRun` create `run.reviewMode = input.reviewMode ?? null`; insert `review_mode`.
- `closeRun` accept `reviewMode`; update `review_mode`.
- `endRun` input `reviewMode`; when mode != none, set `review=true`; when mode none, `review=false`. For post-hoc:
  - list run cards; for each card with status `done` and run_mode != none:
    - set `cards.status='review'`, `done_at=null`, `updated_at=now`;
    - set `run_cards.status='review'`;
    - append `card.reopened_for_review`? Use `card.review_requested` event.
  - Do not release or unmerge; `inDev`/`mergeCommit` stay.
- `endRun` returns run with `reviewMode`.
- `finishCard` input `forceReview`; status `reviewRequired || forceReview ? 'review' : 'done'`.

`src/cli/commands/run.ts`:
- `start`: resolve `runReview.mode` from settings/model context; pass to `startRun`.
- `end`: resolve mode:
  - `--no-review` → `none`;
  - `--review` → `auto` (resolve with model context) or `subagent` fallback;
  - otherwise use `run.reviewMode ?? settings.runReview.mode` resolved;
  - pass to `endRun`.
- Human output includes mode and card count.

`src/cli/commands/finish.ts`:
- Read card and its run; use `run?.reviewMode ?? resolveRunReviewMode(...).mode` so old runs without a snapshot still respect the current setting.
- `forceReview = resolvedMode !== 'none'`.
- Pass to `finishCard`.
- For a card with no run (owner) forceReview false.

- [ ] **Step 4: Update review package acceptance**

`src/cli/commands/review.ts` `ReviewItem` add `acceptance`, `spec` (alias for body), `plan` (alias for steps); format includes them. This is needed for Task 8/e2e.

- [ ] **Step 5: Run tests and commit**

Run: `node --test tests/core/runs.test.ts tests/cli/run-cli.test.ts tests/core/take-finish.test.ts tests/cli/card-detail.test.ts`
Expected: PASS.

```bash
git add src/core/types.ts src/core/runs.ts src/core/lifecycle.ts src/cli/commands/run.ts src/cli/commands/finish.ts src/cli/commands/review.ts tests/core/runs.test.ts tests/cli/run-cli.test.ts tests/core/take-finish.test.ts
git commit -m "feat: snapshot run review mode and cover all run cards"
```

---

### Task 8: Plan compliance, one-cycle cap and legacy commands

**Files:**
- Modify: `src/core/review.ts`
- Modify: `src/cli/commands/review.ts`
- Modify: `src/cli/commands/card.ts` (`verdict` alias)
- Modify: `src/cli/args.ts` (`plan` flag)
- Test: `tests/core/review.test.ts`
- Test: `tests/cli/review-cli.test.ts` (create if absent)
- Test: `tests/cli/card-shape-cli.test.ts` / `tests/cli/run-cli.test.ts`

**Interfaces:**
- `SubmitVerdictInput` add `planCompliance: 'done' | 'failed'`, `mode?: 'self' | 'subagent'`.
- `submitVerdict` returns `{ card, findings }`; stores `kind='run'`, `mode`, `plan_compliance`, `spec_rev`.

- [ ] **Step 1: Write failing tests**

- `review submit --verdict done --plan done --note ...` closes the card and creates findings; review row has `plan_compliance='done'`.
- `review submit --verdict done --plan failed` fails with code 3.
- `review submit --verdict reopen --plan done` is allowed only when spec/plan failed? The design permits reopen only for spec/plan failure; the CLI cannot verify. Keep the rule: `plan failed` requires reopen; `plan done` + reopen is allowed but the reviewer should use findings. Do not add a hard rule beyond plan failed.
- `review submit --verdict reopen --plan failed` increments `reviewReopens` and `attempt`; card goes `ready`/`waiting`.
- Second non-owner reopen fails with code 2, card remains `review`, findings exist.
- `review submit --as owner --verdict reopen --plan failed` bypasses the cap.
- `card verdict --plan done --done` is an alias with the same behavior; missing `--plan` fails code 3.
- `run end --review` post-hoc cards can be reviewed and closed; no second loop.
- Critical finding blocks release; important/other do not.

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/core/review.test.ts tests/cli/review-cli.test.ts`
Expected: FAIL because `--plan` and the cap do not exist.

- [ ] **Step 3: Implement plan compliance and cap**

`src/core/review.ts`:
- `SubmitVerdictInput` add fields.
- Validate `planCompliance` is `done|failed` when provided; the CLI requires it for run review.
- On `planCompliance === 'failed' && verdict !== 'reopen'` throw code 3.
- On reopen:
  - if `card.reviewReopens >= 1 && reviewer !== 'owner'` throw `UserError(2, 'нужно решение владельца: один reopen уже был')` and do not change the card;
  - else update `review_reopens = review_reopens + 1, attempt = attempt + 1`, set ready/waiting, previous_holder, clear run fields; insert review row with `kind='run'`, `mode`, `plan_compliance`.
- On done: insert review row with `kind='run'`, `mode`, `plan_compliance`, `spec_rev`.
- Keep findings creation before the verdict; findings are cards.
- Critical findings already block release via `severity`; no change.

`src/cli/commands/review.ts`:
- `submit`: require `--plan done|failed`; require `--verdict`; reviewer from `--reviewer`/`--as`; mode from `--mode` or the card's run `reviewMode`; pass.
- `card verdict`: call the same path; require `--plan`; map `--done`/`--reopen`.

`src/cli/args.ts`: add `plan`, `mode`.

- [ ] **Step 4: Run tests and commit**

Run: `node --test tests/core/review.test.ts tests/cli/review-cli.test.ts tests/cli/card-shape-cli.test.ts tests/cli/run-cli.test.ts`
Expected: PASS.

```bash
git add src/core/review.ts src/cli/commands/review.ts src/cli/commands/card.ts src/cli/args.ts tests/core/review.test.ts tests/cli/review-cli.test.ts
git commit -m "feat: enforce plan compliance and one review cycle"
```

---

### Task 9: Reviewer model integration and OpenCode plugin context

**Files:**
- Modify: `src/core/review-policy.ts` (if not already)
- Modify: `src/cli/commands/setup.ts` (reviewer model validation/default)
- Modify: `src/cli/commands/card.ts` / `run.ts` / `finish.ts` (env context)
- Modify: `src/core/opencode.ts` (`PLUGIN_SOURCE`)
- Modify: `.opencode/plugins/board/index.ts` (regenerated)
- Test: `tests/core/review-policy.test.ts`
- Test: `tests/core/opencode.test.ts`
- Test: `tests/cli/setup-cli.test.ts`

**Interfaces:**
- `modelContext(process.env)` returns `BOARD_MODEL_VARIANT`/`BOARD_SESSION_MODEL`.
- Plugin calls CLI with `env` containing those values.
- `reviewer.model` validation rejects `#variant`.

- [ ] **Step 1: Write failing tests**

- `setup --reviewer-model 'provider/model#max'` fails code 3; `provider/model` passes.
- `setup --show --json` on a session with `BOARD_SESSION_MODEL` shows the effective reviewer model.
- Generated plugin contains `ctx.session.get`, `BOARD_MODEL_VARIANT`, `BOARD_SESSION_MODEL`, and passes `context` to `call`.
- `board setup` tool action list includes reviewer modes.

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/core/review-policy.test.ts tests/core/opencode.test.ts tests/cli/setup-cli.test.ts`
Expected: FAIL because the plugin does not read the session or pass env.

- [ ] **Step 3: Implement plugin model context**

In `PLUGIN_SOURCE`:

```ts
async function call(ctx, args, context) {
  const { file, args: prefix } = resolveCli(ctx)
  let env = process.env
  try {
    const session = await ctx.session.get({ sessionID: context.sessionID })
    const model = session.model
    env = {
      ...process.env,
      BOARD_MODEL_VARIANT: model.variant ?? '',
      BOARD_SESSION_MODEL: model.providerID + '/' + model.id,
    }
  } catch {}
  const { stdout } = await run(file, [...prefix, ...args, '--json'], {
    cwd: ctx.location.directory,
    timeout: 120_000,
    maxBuffer: 8 * 1024 * 1024,
    env,
  })
  return { content: stdout.trim() || '{}' }
}
```

Change every `execute: (input) => call(ctx, ...)` to `execute: (input, context) => call(ctx, ..., context)`. Update `board_setup` action mapping to the new flags (`reviewer-model`, `spec-review`, `large-spec`, `run-review`), and `board_card` actions `spec-review`, `amend`, `verdict` with `plan`/`mode`.

- [ ] **Step 4: Update CLI context and setup**

- `setup` reads `modelContext(process.env)` and, when `reviewer.model` is empty, shows the session model as the suggested default. `--reviewer-model` validates no `#`.
- `card show`/`submit`/`approve`, `run start`/`end`, `finish` use `modelContext(process.env)` for policy.
- `setup` warns when `specReview.mode=subagent`/`runReview.mode=subagent` and no reviewer model is available.

- [ ] **Step 5: Regenerate the tracked plugin and run tests**

Run: `node bin/board.ts init --refresh --yes` (or `node bin/board.ts setup --refresh` if implemented) to regenerate `.opencode/plugins/board/index.ts` and commands.
Run: `node --test tests/core/review-policy.test.ts tests/core/opencode.test.ts tests/cli/setup-cli.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/core/review-policy.ts src/cli/commands/setup.ts src/cli/commands/card.ts src/cli/commands/run.ts src/cli/commands/finish.ts src/core/opencode.ts .opencode/plugins/board/index.ts tests/core/review-policy.test.ts tests/core/opencode.test.ts tests/cli/setup-cli.test.ts
git commit -m "feat: pass model context to reviewers"
```

---

### Task 10: Reviewer agent, commands, skill and AGENTS

**Files:**
- Modify: `src/core/opencode.ts`
- Generate at runtime: `.opencode/agents/board-reviewer.md` (ignored by git)
- Modify: `.opencode/command/review.md`
- Modify: `.opencode/command/spec-review.md` (create)
- Modify: `.opencode/command/setup.md`
- Modify: `.opencode/skills/board/SKILL.md`
- Modify: `AGENTS.md` (block regenerated)
- Test: `tests/core/opencode.test.ts`

**Interfaces:**
- `writeOpenCodeFiles(root, { refresh, settings })` writes the reviewer agent when `settings.reviewer.model` is set and removes it when empty.
- `/review` and `/spec-review` are `subagent: false` orchestrators; they launch `board-reviewer` only for `subagent` mode.
- `board-reviewer` has `mode: subagent`, `model: <reviewer.model>` with no `#variant`, and read-only permissions.

- [ ] **Step 1: Write failing tests**

- `writeOpenCodeFiles` creates `.opencode/agents/board-reviewer.md` when `reviewer.model` is set; the file contains `mode: subagent`, `model: provider/model`, and no `#`.
- When `reviewer.model` is null, the file is absent.
- `/review` command has `subagent: false` and mentions spec/acceptance/plan and `review submit --plan`.
- `/spec-review` command has `subagent: false`, mentions self/subagent, and `card spec-review`.
- Skill/AGENTS mention spec, plan, acceptance, one-cycle, findings backlog, reviewer default model.
- `writeOpenCodeFiles(..., { refresh: true })` updates the agent and commands; without refresh it leaves them alone.

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/core/opencode.test.ts`
Expected: FAIL because the agent and commands do not exist.

- [ ] **Step 3: Implement templates and agent writing**

- Add `REVIEWER_AGENT_SOURCE` as a function:
  ```ts
  function reviewerAgentSource(model: string): string {
    return `---\ndescription: Read-only reviewer for spec, plan and code\nmode: subagent\nmodel: ${model}\npermissions:\n  - action: edit\n    resource: "*"\n    effect: deny\n  - action: read\n    resource: "*"\n    effect: allow\n  - action: shell\n    resource: "*"\n    effect: allow\n---\n\nReview only. Do not modify files. Return findings with file and line references.`
  }
  ```
  Adjust permissions to the schema; the reviewer needs shell for `board` commands and tests, but no edit.
- Add `SPEC_REVIEW_COMMAND_SOURCE`:
  - `subagent: false`;
  - prompt: read `board card show $1 --json`; if `specReview.mode=none`, stop; if `self`, check the six checklist questions and record; if `subagent`, launch `board-reviewer` with the spec and record `--mode subagent`; if gaps, fill or ask owner.
- Update `COMMAND_SOURCE`:
  - `subagent: false`;
  - read `board review list --json`;
  - check acceptance/spec, plan steps, code;
  - use `board review finding` for findings;
  - use `board review submit --plan done|failed`; no reopen for code polish;
  - one-cycle rule.
- Update `SETUP_COMMAND_SOURCE` for the four modes and no-change branch.
- Update `SKILL_SOURCE`/`AGENTS_BLOCK` with spec/plan, spec review, plan at take, run review checks, one-cycle, fix run.
- Add `writeReviewerAgent(root, settings)`:
  - path `.opencode/agents/board-reviewer.md`;
  - if model null, `rmSync` if exists;
  - else write with `mode: subagent`, model, permissions.
- `writeOpenCodeFiles` accepts `settings` (or call `writeReviewerAgent` separately from `initProject`/`setup`).
- `initProject` passes settings; `setup` updates the agent on change; `init --refresh` refreshes it.

- [ ] **Step 4: Regenerate tracked files and run tests**

Run: `node bin/board.ts init --refresh --yes`
Run: `node --test tests/core/opencode.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/opencode.ts src/core/project.ts src/cli/commands/setup.ts .opencode/command .opencode/skills AGENTS.md tests/core/opencode.test.ts
git commit -m "feat: add reviewer agent and spec/plan commands"
```

`board-reviewer.md` lives under `.opencode/agents/`, which is gitignored; it is generated locally by `init`/`setup` and must not be committed.

---

### Task 11: Documentation, end-to-end test and full suite

**Files:**
- Modify: `README.md`
- Modify: `docs/superpowers/specs/2026-11-19-toolbox-board-design.md` (add a superseded note or update sections)
- Modify: `docs/board/terminology.md` (add spec, plan, spec review, run review, finding, fix run)
- Create: `tests/e2e/spec-plan-review.test.ts`
- Test: full `node --test`

- [ ] **Step 1: Write the e2e test**

Scenario:

1. `init`; `setup --spec-review self --run-review subagent --reviewer-model opencode-go/deepseek-v4.1-flash`.
2. Create three requests; shape each with `spec` + acceptance.
3. For each: `spec-review --mode self --verdict done`, `submit`, `approve`.
4. `run start --cards ...`; `take` each; add a step; `finish`.
5. `run end`; assert all cards are `review` (run mode subagent).
6. `review list --json` includes spec/acceptance/plan.
7. `review submit --plan done --verdict done --findings ...` for each; assert cards `done`, findings `new`.
8. Assert a second review is not required; `review list` is empty.
9. Create a critical finding and assert `release` exits code 2; important/other findings do not block.
10. Approve findings, start a fix run, execute one, assert the fix run uses the same gates.

- [ ] **Step 2: Run the e2e test to verify it fails**

Run: `node --test tests/e2e/spec-plan-review.test.ts`
Expected: FAIL until all pieces are integrated.

- [ ] **Step 3: Fix integration gaps**

Likely gaps: CLI flag names, settings default, review package fields, `run end` post-hoc review, owner override. Fix them in the owning modules; do not add new behavior outside the spec.

- [ ] **Step 4: Update docs**

- README: spec is the contract, owner approves spec; plan at take; spec review modes; run review modes; reviewer default model; one-cycle; fix run; command table (`card spec-review`, `card amend`, `review submit --plan`, `setup` flags).
- Design doc: add a note at the top of the old board design that the new workflow supersedes §8.4/§9/§10/§14.
- `docs/board/terminology.md`: add the new terms with one-line definitions.

- [ ] **Step 5: Run the full suite**

Run: `node --test`
Expected: PASS, all existing + new tests.

- [ ] **Step 6: Commit**

```bash
git add README.md docs tests/e2e/spec-plan-review.test.ts
git commit -m "test: cover spec/plan workflow end to end"
```

---

## Execution Notes

- Keep commits on `dev`; do not merge to `main` or release without the owner.
- After each task, run the focused tests before committing. If a test failure reveals a gap in the spec, stop and fix the spec/plan rather than inventing behavior.
- The uncommitted v1 settings feature is already committed at `5aab632`; this plan replaces its `reviewAfterRun` interface but keeps the deprecated CLI aliases for compatibility.
- `card verdict` is intentionally kept as an alias; do not add a second `submitVerdict` path.
- `run end --review` is intentionally allowed to move already-done cards into post-hoc review; do not remove that behavior without an owner decision.
