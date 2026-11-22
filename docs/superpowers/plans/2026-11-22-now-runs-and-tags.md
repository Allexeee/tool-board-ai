# NOW-2: теги, вероятные забеги и запросы в забеге — план

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Дать `now` вкладки 0–3 с вероятными забегами по тегам и научить забег брать запросы, разбирать их и продвигать в работу без отдельного approve.

**Architecture:** Теги — JSON-колонка `cards.tags` (схема v3). Три варианта забега — правило над тегами `new`/`improve`/`review`, без отдельной сущности. Запрос в забеге — строка `run_cards` со статусом `planned` и заполненным `cards.run_id`; `take` идёт в два шага: shaping, затем promotion в `in_progress` с веткой и lease.

**Tech Stack:** TypeScript, Node 24+, `node:sqlite`, `node:test`, git worktree.

**Spec:** `docs/superpowers/specs/2026-11-22-now-runs-and-tags-design.md`

## Global Constraints

- Схема БД: v3. Миграции только вперёд; v1 → v3 и v2 → v3 обязательны.
- `now` без аргумента — вкладка 0.
- Теги нормализуются: trim, нижний регистр, дедупликация, пустые отбрасываются.
- Варианты забега: `new` → «НОВОЕ», `improve` → «УЛУЧШЕНИЕ», `review` → «ПОСЛЕ РЕВЬЮ».
- В `now 0`/`now 1` имя исполнителя в тексте не печатается; в JSON `executor` остаётся.
- ANSI только в TTY; в `--json`, пайпе и `NO_COLOR` его нет.
- Запросы в забеге не проходят `submit`/`approve`; promotion пишет событие.
- Все существующие тесты должны остаться зелёными после обновления ожиданий.

## Review Focus

- План запроса, который после promotion остаётся без `position` и исчезает из очереди при block/reopen.
- `planned`-запрос, который `run next` возвращает повторно после `block` или открытого вопроса.
- `waiting`-карточка с зависимостью вне забега, которую предложение берёт, а `startRun` потом отвергает.
- `--tag` на `card edit`, который неожиданно заменяет `review` у находки и уводит её из «ПОСЛЕ РЕВЬЮ».
- `now 2` с `--as` текущего агента, который всё ещё показывает его самого.

---

### Task 1: Схема v3 и теги на карточке

**Files:**
- Modify: `src/core/types.ts` (`Card`, `CardFilter`, `NewCardInput`, `CardPatch`)
- Modify: `src/core/schema.ts` (`SCHEMA_VERSION`, DDL, миграции)
- Modify: `src/core/cards.ts` (`toCard`, `createCard`, `editCard`, `listCards`)
- Modify: `src/core/shape.ts` (`ShapeFile.tags`) — найти файл по `ShapeFile`
- Test: `tests/core/schema.test.ts`, `tests/core/cards.test.ts`

**Interfaces:**
- Produces: `Card.tags: string[]`; `normalizeTags(raw: string[]): string[]`; `CardFilter.tag?: string`.
- Produces: `SCHEMA_VERSION = 3`; `MIGRATE_V2_TO_V3`.

- [ ] **Step 1: Написать падающие тесты схемы**

```ts
test('v2 → v3 добавляет tags и помечает находки review', () => {
  const { db } = makeV2Board()
  seedV2Card(db, { id: 'UI-1', originCardId: 'UI-9' })
  migrate(db)
  const row = db.prepare("select tags from cards where id = 'UI-1'").get() as { tags: string }
  assert.deepEqual(JSON.parse(row.tags), ['review'])
})

test('v1 → v3 проходит обе миграции', () => {
  const { db } = makeV1Board()
  migrate(db)
  assert.equal(schemaVersionOf(db), 3)
  assert.deepEqual(getCardTags(db, 'UI-1'), [])
})
```

- [ ] **Step 2: Запустить и убедиться, что падает**

Run: `node --test tests/core/schema.test.ts`
Expected: FAIL — `SCHEMA_VERSION` равен 2, колонки `tags` нет.

- [ ] **Step 3: Реализовать**

В `schema.ts`:
```ts
export const SCHEMA_VERSION = 3
const MIGRATE_V2_TO_V3 = `
alter table cards add column tags text not null default '[]';
update cards set tags = '["review"]' where origin_card_id is not null;
`
```
В `DDL` добавить `tags text not null default '[]'` в `cards`.
В `migrate`: `from === 1` → `MIGRATE_V1_TO_V2` + `MIGRATE_V2_TO_V3`; `from === 2` → `MIGRATE_V2_TO_V3`.

В `cards.ts`:
```ts
export function normalizeTags(raw: string[]): string[] {
  return [...new Set(raw.map((tag) => tag.trim().toLowerCase()).filter(Boolean))]
}
```
`toCard` → `tags: JSON.parse(row.tags) as string[]`; `createCard` и `editCard` пишут `JSON.stringify(normalizeTags(...))`; `listCards` поддерживает `filter.tag` через `json_each(cards.tags)`.

- [ ] **Step 4: Добавить тесты карточек**

```ts
test('tags сохраняются, заменяются и фильтруются', () => {
  const card = createCard(db, { group: 'UI', title: 't', skill: 'dev', author: 'owner', tags: [' New ', 'new', 'backend'] })
  assert.deepEqual(card.tags, ['new', 'backend'])
  const edited = editCard(db, { id: card.id, actor: 'owner', patch: { tags: ['review'] } })
  assert.deepEqual(edited.tags, ['review'])
  assert.deepEqual(listCards(db, { tag: 'review' }).map((c) => c.id), [card.id])
})
```

- [ ] **Step 5: Прогнать тесты**

Run: `node --test tests/core/schema.test.ts tests/core/cards.test.ts`
Expected: PASS.

- [ ] **Step 6: Коммит**

```bash
git add src/core/types.ts src/core/schema.ts src/core/cards.ts src/core/shape.ts tests/core/schema.test.ts tests/core/cards.test.ts
git commit -m "feat: tags on cards and schema v3"
```

---

### Task 2: CLI тегов и автотег находок

**Files:**
- Modify: `src/cli/commands/card.ts` (`add`, `edit`, `show`)
- Modify: `src/core/review.ts` (`addFinding`)
- Test: `tests/cli/card-add.test.ts`, `tests/cli/card-detail.test.ts`, `tests/core/review.test.ts`

**Interfaces:**
- Consumes: `normalizeTags`, `CardPatch.tags`.
- Produces: `card add|edit --tag <tag>` (повторяемый), `--clear-tags`; `addFinding` ставит `tags: ['review']` поверх наследования.

- [ ] **Step 1: Написать падающие CLI-тесты**

```ts
test('card add и edit принимают теги', () => {
  const added = json(dir, ['card', 'add', '--group', 'UI', '--title', 't', '--skill', 'dev', '--tag', 'New', '--tag', 'backend'])
  assert.deepEqual(added.tags, ['new', 'backend'])
  const edited = json(dir, ['card', 'edit', 'UI-1', '--tag', 'review'])
  assert.deepEqual(edited.tags, ['review'])
  const cleared = json(dir, ['card', 'edit', 'UI-1', '--clear-tags'])
  assert.deepEqual(cleared.tags, [])
})
```

- [ ] **Step 2: Запустить и убедиться, что падает**

Run: `node --test tests/cli/card-add.test.ts`
Expected: FAIL — неизвестный флаг `--tag`.

- [ ] **Step 3: Реализовать**

В `card.ts` `add`: `tags: stringsFlag(args, 'tag')`; `edit`: `if (args.flags.tag !== undefined) patch.tags = stringsFlag(args, 'tag')`; `if (args.flags['clear-tags'] !== undefined) patch.tags = []`; `formatCard` печатает строку `ТЕГИ: ...`, если непусто.
В `review.ts` `addFinding`: `tags: ['review']` (не наследовать теги исходной карточки).

- [ ] **Step 4: Тест автотега**

```ts
test('addFinding ставит тег review', () => {
  const finding = addFinding(db, { cardId: 'UI-1', severity: 'important', text: 'x', reviewer: 'r' })
  assert.deepEqual(finding.tags, ['review'])
})
```

- [ ] **Step 5: Прогнать**

Run: `node --test tests/cli/card-add.test.ts tests/cli/card-detail.test.ts tests/core/review.test.ts`
Expected: PASS.

- [ ] **Step 6: Коммит**

```bash
git add src/cli/commands/card.ts src/core/review.ts tests/cli/card-add.test.ts tests/cli/card-detail.test.ts tests/core/review.test.ts
git commit -m "feat: card tags in CLI and review findings"
```

---

### Task 3: Варианты забегов и вероятные предложения

**Files:**
- Create: `src/core/tags.ts`
- Modify: `src/core/runs.ts` (`RunSuggestion`, `suggestVariantRuns`)
- Test: `tests/core/tags.test.ts`, `tests/core/runs.test.ts`

**Interfaces:**
- Produces:
```ts
export const RUN_VARIANTS = [
  { tag: 'new', label: 'НОВОЕ' },
  { tag: 'improve', label: 'УЛУЧШЕНИЕ' },
  { tag: 'review', label: 'ПОСЛЕ РЕВЬЮ' },
] as const
export type RunVariant = (typeof RUN_VARIANTS)[number]
export function variantOf(card: Card): RunVariant | null
```
- Produces:
```ts
export interface RunSuggestion {
  executorId: string
  cards: Card[]
  group: string | null
  tag: string | null
  label: string | null
}
export function suggestVariantRuns(
  db: DatabaseSync,
  executorId: string,
  options?: { group?: string; skill?: string; runSize?: number },
): RunSuggestion[]
```

- [ ] **Step 1: Тест `variantOf`**

```ts
test('variantOf берёт первый тег в порядке new, improve, review', () => {
  assert.equal(variantOf(cardWithTags(['review', 'new']))?.tag, 'new')
  assert.equal(variantOf(cardWithTags(['backend']))?.tag, null)
})
```

- [ ] **Step 2: Тест `suggestVariantRuns`**

```ts
test('три варианта, до run_size, без пересечений, запросы первыми', () => {
  seedExecutor(db, { id: 'dev', skills: ['dev'], runSize: 3 })
  const req = seedCard(db, { phase: 'request', status: 'new', tags: ['new'] })
  const a = readyCard(db, { position: 1, tags: ['new'] })
  const b = readyCard(db, { position: 2, tags: ['improve'] })
  const c = readyCard(db, { position: 3, tags: ['review'] })
  const runs = suggestVariantRuns(db, 'dev')
  assert.deepEqual(runs.map((run) => run.tag), ['new', 'improve', 'review'])
  assert.deepEqual(runs[0].cards.map((card) => card.id), [req.id, a.id])
  assert.deepEqual(new Set(runs.flatMap((run) => run.cards.map((card) => card.id))).size, 4)
})
```

- [ ] **Step 3: Реализовать `tags.ts` и `suggestVariantRuns`**

`tags.ts` — константы, `variantOf`, `isVariantTag`.
`suggestVariantRuns`:
- кандидаты: skill match; запросы `new`/`shaping` (holder null или = executor); задачи `ready`/`waiting` (holder null, position != null);
- фильтр `group`/`skill`;
- деп-правило `depsStartable` (переиспользовать существующую функцию из `runs.ts`);
- для каждого варианта: запросы по `createdAt`, затем задачи по `position`; до `runSize`; пропускать карточку, если порядок нарушает зависимость;
- не добавлять карточку во второй вариант;
- пустые варианты не возвращать.

- [ ] **Step 4: Прогнать**

Run: `node --test tests/core/tags.test.ts tests/core/runs.test.ts`
Expected: PASS.

- [ ] **Step 5: Коммит**

```bash
git add src/core/tags.ts src/core/runs.ts tests/core/tags.test.ts tests/core/runs.test.ts
git commit -m "feat: tagged run variants"
```

---

### Task 4: `planned`-запросы в забеге

**Files:**
- Modify: `src/core/types.ts` (`RunCardStatus`)
- Modify: `src/core/runs.ts` (`startRun`, `addToRun`, `dropFromRun`, `endRun`, `reclaimExpired`)
- Modify: `src/core/lifecycle.ts` (`blockCard`, `cancelCard`)
- Test: `tests/core/runs.test.ts`, `tests/core/lifecycle.test.ts`

**Interfaces:**
- Produces: `RunCardStatus = ... | 'planned'`.
- `startRun` принимает `cardIds`, где запросы `new`/`shaping` (holder null или = actor) добавляются как `planned`, `cards.run_id = run.id`, фаза/статус/держатель не меняются.
- `run_size` считает и запросы, и задачи.

- [ ] **Step 1: Тест `startRun` с запросом**

```ts
test('startRun принимает запрос как planned и заполняет run_id', () => {
  const req = seedCard(db, { phase: 'request', status: 'new' })
  const run = startRun(db, { executorId: 'dev', cardIds: [req.id], actor: 'dev' })
  const card = getCard(db, req.id)!
  const rc = listRunCards(db, run.id)[0]
  assert.equal(card.status, 'new')
  assert.equal(card.runId, run.id)
  assert.equal(rc.status, 'planned')
})
```

- [ ] **Step 2: Запустить и убедиться, что падает**

Run: `node --test tests/core/runs.test.ts`
Expected: FAIL — запрос не проходит проверку фазы.

- [ ] **Step 3: Реализовать**

В `startRun`: разделить `cardIds` на tasks/requests; для задач — текущая логика; для запросов — валидация (существует, request, new/shaping, holder null или actor, skill match, нет в другом забеге), `update cards set run_id = ?`, `insert run_cards(..., 'planned')`, `run_size` учитывает всё.
`addToRun`/`dropFromRun` — те же правила; `drop` очищает `run_id`.
`endRun`/`reclaimExpired`: `planned` возвращаются в `request` (статус не меняется), `run_id = null`.
`blockCard`/`cancelCard`: находить `run_cards` по `cards.run_id` и ставить `blocked`/`dropped` даже для `planned`.

- [ ] **Step 4: Тесты block/cancel/end**

```ts
test('block planned-запроса помечает run_cards', () => {
  blockCard(db, { id: req.id, actor: 'dev', reason: 'needs_decision', note: '?' })
  assert.equal(listRunCards(db, run.id)[0].status, 'blocked')
})
test('endRun возвращает planned в request и очищает run_id', () => {
  endRun(db, { runId: run.id, actor: 'dev' })
  assert.equal(getCard(db, req.id)!.status, 'new')
  assert.equal(getCard(db, req.id)!.runId, null)
})
```

- [ ] **Step 5: Прогнать**

Run: `node --test tests/core/runs.test.ts tests/core/lifecycle.test.ts`
Expected: PASS.

- [ ] **Step 6: Коммит**

```bash
git add src/core/types.ts src/core/runs.ts src/core/lifecycle.ts tests/core/runs.test.ts tests/core/lifecycle.test.ts
git commit -m "feat: planned requests in runs"
```

---

### Task 5: `take` — shaping и promotion

**Files:**
- Modify: `src/core/lifecycle.ts` (`takeCard`, helper `startWork`)
- Modify: `src/cli/commands/take.ts`
- Test: `tests/core/take-finish.test.ts`, `tests/cli/take-cli.test.ts`

**Interfaces:**
- `takeCard(db, { id, actor, root })`:
  - booked task → как сейчас;
  - `planned`-запрос `new` → `shapeCard`, вернуть `shaping`;
  - `planned`-запрос `shaping` + holder=actor → проверить spec/acceptance/skill/scores/scope, создать ветку/worktree и поставить `in_progress`, `run_cards.status='in_progress'`, событие `card.promoted`.
- Produces: `startWork(db, { card, actor, root, runId }): Card` — общая часть с обычным take.

- [ ] **Step 1: Тест двухфазного take**

```ts
test('take запроса: сначала shaping, потом promotion с веткой', () => {
  const req = seedCard(db, { phase: 'request', status: 'new' })
  const run = startRun(db, { executorId: 'dev', cardIds: [req.id], actor: 'dev' })
  const shaped = takeCard(db, { id: req.id, actor: 'dev', root })
  assert.equal(shaped.status, 'shaping')
  editCard(db, { id: req.id, actor: 'dev', patch: { body: 'spec', acceptance: 'ok', scope: ['src/**'] } })
  editCard(db, { id: req.id, actor: 'owner', patch: { importance: 2, urgency: 2 } })
  const promoted = takeCard(db, { id: req.id, actor: 'dev', root })
  assert.equal(promoted.phase, 'task')
  assert.equal(promoted.status, 'in_progress')
  assert.equal(promoted.runId, run.id)
  assert.ok(promoted.branch)
  assert.equal(listRunCards(db, run.id)[0].status, 'in_progress')
})
```

- [ ] **Step 2: Запустить и убедиться, что падает**

Run: `node --test tests/core/take-finish.test.ts`
Expected: FAIL — «не забронирована: new».

- [ ] **Step 3: Реализовать**

Вынести из `takeCard` создание ветки/lease в `startWork`; в `takeCard` добавить ветку для `planned`-запроса. После promotion проверить, что `finishCard` проходит на `needs_merge=true`.

- [ ] **Step 4: Тест вопросов и повторного take**

```ts
test('запрос с открытым вопросом пропускается run next', () => {
  ask(db, { cardId: req.id, author: 'dev', text: '?' })
  assert.equal(nextCard(db, { runId: run.id, actor: 'dev' })?.id, undefined)
})
```

- [ ] **Step 5: Прогнать**

Run: `node --test tests/core/take-finish.test.ts tests/cli/take-cli.test.ts`
Expected: PASS.

- [ ] **Step 6: Коммит**

```bash
git add src/core/lifecycle.ts src/cli/commands/take.ts tests/core/take-finish.test.ts tests/cli/take-cli.test.ts
git commit -m "feat: shape and promote requests in runs"
```

---

### Task 6: Вкладки `now` и рендер

**Files:**
- Modify: `src/core/now.ts` (`NowView`, `nowData`, `renderNow`)
- Modify: `src/cli/commands/now.ts` (default 0, filters)
- Test: `tests/core/now.test.ts`, `tests/cli/now-cli.test.ts`

**Interfaces:**
- `NowView` для view 1: `executor`, `skills`, `current`, `queue`, `probableRuns: Array<{ tag, label, cards: Array<{ card, request }> }>`, `untagged: number`.
- view 2: `executors` без текущего.
- view 0: `ownerCards` включает `ready` и `waiting`.
- `now` default 0.

- [ ] **Step 1: Тесты вкладок**

```ts
test('now по умолчанию — view 0', () => {
  assert.equal(nowData(db, { view: 0, executorId: 'owner' }).view, 0)
})
test('now 1 строит три вероятных забега и помечает запросы', () => {
  const data = nowData(db, { view: 1, executorId: 'dev' })
  assert.deepEqual(data.probableRuns!.map((run) => run.tag), ['new', 'improve', 'review'])
  assert.equal(data.probableRuns![0].cards[0].request, true)
})
test('now 2 исключает текущего агента', () => {
  const data = nowData(db, { view: 2, executorId: 'dev' })
  assert.ok(data.executors!.every((item) => item.id !== 'dev'))
})
```

- [ ] **Step 2: Тесты текста**

```ts
test('now 0 и now 1 не печатают исполнителя в конце', () => {
  assert.doesNotMatch(renderNow(now0), /owner\s*$/)
  assert.doesNotMatch(renderNow(now1), /МОИ ЗАДАЧИ — /)
})
test('now 1 печатает карточку забега отдельной строкой', () => {
  assert.match(text, /^\s+\?\s+NOW-\d+\s+/m)
})
```

- [ ] **Step 3: Реализовать**

`now.ts`: `ownerView` — `listCards({ skill: 'owner', status: ['ready', 'waiting'] })`; `agentView` — `suggestVariantRuns`; `allAgentsView` — пропускать `executorId`; `renderNow` — секции `НА РУКАХ`, `ОЧЕРЕДЬ`, `ВЕРОЯТНЫЕ ЗАБЕГИ`, строки `?  ID  title`, `untagged`.
`now.ts` CLI: `parseView(undefined) → 0`; `--group`/`--skill` передаются в `suggestVariantRuns`.

- [ ] **Step 4: Прогнать**

Run: `node --test tests/core/now.test.ts tests/cli/now-cli.test.ts`
Expected: PASS.

- [ ] **Step 5: Коммит**

```bash
git add src/core/now.ts src/cli/commands/now.ts tests/core/now.test.ts tests/cli/now-cli.test.ts
git commit -m "feat: now tabs with probable runs"
```

---

### Task 7: `run start --suggest`, документация и e2e

**Files:**
- Modify: `src/cli/commands/run.ts` (`--suggest` → вариант)
- Modify: `README.md`, `.opencode/skills/board/SKILL.md`, `src/core/opencode.ts` (skill/AGENTS text), `docs/board/terminology.md`
- Test: `tests/cli/run-cli.test.ts`, `tests/e2e/board.test.ts`

**Interfaces:**
- `run start --suggest <n>`: n = 1/2/3 → вариант `new`/`improve`/`review`.
- E2E: забег с запросом: shape → promotion → finish; `now 1` показывает запрос.

- [ ] **Step 1: Тест `--suggest`**

```ts
test('run start --suggest 2 берёт вариант improve', () => {
  const out = json(dir, ['run', 'start', '--as', 'dev', '--suggest', '2'])
  const cards = listRunCards(db, out.id).map((rc) => getCard(db, rc.cardId)!)
  assert.ok(cards.every((card) => card.tags.includes('improve')))
})
```

- [ ] **Step 2: Реализовать и обновить тексты**

`run.ts`: `suggestVariantRuns(...)[n-1]`; ошибка, если варианта нет.
Skill/AGENTS: теги `new`/`improve`/`review`, три варианта, `take` в два шага, approve в забеге пропускается.
README/terminology: те же правила.

- [ ] **Step 3: E2E**

```ts
test('забег с запросом: разбор, promotion, finish', () => {
  const request = json(root, ['card', 'add', '--group', 'NOW', '--title', 'Новое', '--skill', 'dev', '--tag', 'new'])
  const run = json(root, ['run', 'start', '--as', 'dev', '--cards', request.id])
  assert.equal(json(root, ['run', 'next', '--as', 'dev']).request, true)
  assert.equal(run(root, ['take', request.id, '--as', 'dev']).code, 0) // shaping
  // edit spec/acceptance/scope/importance/urgency
  assert.equal(run(root, ['take', request.id, '--as', 'dev']).code, 0) // promotion
  assert.equal(json(root, ['card', 'show', request.id]).status, 'in_progress')
})
```

- [ ] **Step 4: Полный прогон**

Run: `node --test`
Expected: PASS, все тесты.

- [ ] **Step 5: Коммит**

```bash
git add src/cli/commands/run.ts README.md .opencode/skills/board/SKILL.md src/core/opencode.ts docs/board/terminology.md tests/cli/run-cli.test.ts tests/e2e/board.test.ts
git commit -m "feat: run suggestions by tag and docs"
```

---

## Self-Review

- Spec coverage: schema/tags (1–2), variants (3), planned requests (4), take/promotion (5), tabs/render (6), suggest/docs/e2e (7). Вкладка 3 не меняется; default 0 — Task 6.
- Типы: `RunSuggestion` расширяется в Task 3, используется в Task 6; `RunCardStatus` — Task 4, используется в 5–6.
- Review Focus: promotion с `position` (Task 5), повторный `run next` (Task 5), зависимости (Task 3), `--tag` заменяет (Task 2), `now 2` исключает (Task 6).
