# Своя версия board у проекта и superpowers по проектам — план

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Каждый проект работает со своей версией board из git submodule `tools/board`, а superpowers включается только в проектах, где он нужен.

**Architecture:** `tools/board` — submodule на тег/коммит; глобальный `board` — тонкий диспетчер, который делегирует локальному CLI. `board init` ставит submodule и генерирует `.opencode` из его версии; `board upgrade` переключает ref. Superpowers убирается из глобального `opencode.json` и добавляется в `.opencode/opencode.json` нужных проектов.

**Tech Stack:** TypeScript, Node 24+, `node:sqlite`, git submodule, OpenCode V2 plugin/skill config.

**Spec:** `docs/superpowers/specs/2026-11-22-per-project-board-and-superpowers-design.md`

## Global Constraints

- Версия board в проекте — только из `tools/board`; глобальная копия не участвует в операционных командах.
- `BOARD_CLI` — только отладочный override, не основной путь.
- `main` не пишется агентом; релиз и тег делает владелец.
- Схема БД мигрирует только вперёд; даунгрейд требует `--allow-downgrade`.
- Генерируемые `.opencode`-файлы всегда берутся из версии, которая реально запускается.
- Все существующие тесты остаются зелёными.

## Review Focus

- Вызов board из worktree `.worktrees/<id>`, где нет `tools/board`.
- `init` в самом репозитории board, который пытается добавить сам себя submodule.
- Сломанный/устаревший локальный CLI, который нельзя починить через `init`.
- Грязный submodule при `upgrade`.
- Даунгрейд на версию, которая не открывает новую схему БД.
- Проект без локального CLI, где операционная команда молча уходит в глобальную версию.

---

### Task 1: Резолв локального CLI и определение репозитория board

**Files:**
- Modify: `src/core/git.ts` (`findLocalBoardCli`, `isBoardSourceRepo`)
- Test: `tests/core/git.test.ts`

**Interfaces:**
- Produces:
```ts
export function isBoardSourceRepo(root: string): boolean
export function findLocalBoardCli(root: string): string | null
```
`isBoardSourceRepo` — `package.json` с `name === 'tool-board-ai'` и существующие `bin/board.ts`, `src/core/now.ts`.
`findLocalBoardCli` — `tools/board/bin/board.ts`, затем `bin/board.ts` только для source-репозитория; иначе `null`.

- [ ] **Step 1: Тест**

```ts
test('findLocalBoardCli находит tools/board и не путает чужой bin', () => {
  const project = tempGitProject()
  mkdirSync(join(project, 'tools', 'board', 'bin'), { recursive: true })
  writeFileSync(join(project, 'tools', 'board', 'bin', 'board.ts'), '')
  assert.match(findLocalBoardCli(project)!, /tools[\\/]board[\\/]bin[\\/]board\.ts$/)
  assert.equal(isBoardSourceRepo(project), false)
})
```

- [ ] **Step 2: Запустить и убедиться, что падает**

Run: `node --test tests/core/git.test.ts`
Expected: FAIL — функций нет.

- [ ] **Step 3: Реализовать**

В `git.ts` читать `package.json` через `readFileSync`, пути через `join`, проверять `existsSync`. Не бросать на отсутствующем `package.json` — вернуть `false/null`.

- [ ] **Step 4: Прогнать**

Run: `node --test tests/core/git.test.ts`
Expected: PASS.

- [ ] **Step 5: Коммит**

```bash
git add src/core/git.ts tests/core/git.test.ts
git commit -m "feat: resolve project-local board cli"
```

---

### Task 2: Операции с submodule и версией

**Files:**
- Modify: `src/core/git.ts` (`BoardSource`, `latestBoardTag`, `boardSubmoduleState`, `addBoardSubmodule`, `checkoutBoardRef`, `currentBoardVersion`)
- Test: `tests/core/git.test.ts`, `tests/helpers/git.ts` (новый helper для bare-репозитория)

**Interfaces:**
- Produces:
```ts
export type BoardSubmoduleState = 'missing' | 'not-initialized' | 'not-submodule' | 'dirty' | 'ready'
export function latestBoardTag(source: string): string
export function boardSubmoduleState(root: string): BoardSubmoduleState
export function currentBoardVersion(root: string): string | null
export function addBoardSubmodule(root: string, source: string, ref: string): void
export function checkoutBoardRef(root: string, ref: string, options?: { allowDowngrade?: boolean }): void
```

- [ ] **Step 1: Helper и тест bare-репозитория**

```ts
export function makeBoardSource(dir: string): string {
  // git init work; package.json name tool-board-ai, bin/board.ts, src/core/now.ts; commit; tag v1.0.0; clone --bare
}
test('latestBoardTag и submodule add/checkout', () => {
  const source = makeBoardSource(tempDir())
  assert.equal(latestBoardTag(source), 'v1.0.0')
  const project = tempGitProject()
  addBoardSubmodule(project, source, 'v1.0.0')
  assert.equal(currentBoardVersion(project), '1.0.0')
  assert.equal(boardSubmoduleState(project), 'ready')
})
```

- [ ] **Step 2: Запустить и убедиться, что падает**

Run: `node --test tests/core/git.test.ts`
Expected: FAIL — функций нет.

- [ ] **Step 3: Реализовать**

- `latestBoardTag`: `git ls-remote --tags --refs <source>`, распарсить `refs/tags/vX.Y.Z`, semver-сортировка, вернуть последний.
- `boardSubmoduleState`: `tools/board` нет → `missing`; `.gitmodules` без записи или каталог не submodule → `not-submodule`; `git submodule status -- tools/board` начинается с `-` → `not-initialized`; `git -C tools/board status --porcelain` непустой → `dirty`; иначе `ready`.
- `addBoardSubmodule`: `git submodule add <source> tools/board`; `git -C tools/board checkout <ref>`.
- `checkoutBoardRef`: `fetch --tags`, проверить грязность, `checkout <ref>`, сравнить версии из `package.json`; если target < current и нет `allowDowngrade` — `UserError(2, ...)`.
- `currentBoardVersion`: читать `tools/board/package.json`.

- [ ] **Step 4: Тесты dirty/даунгрейда**

```ts
test('dirty submodule не переключается', () => {
  writeFileSync(join(project, 'tools', 'board', 'x.txt'), 'x')
  assert.equal(boardSubmoduleState(project), 'dirty')
  assert.throws(() => checkoutBoardRef(project, 'v1.1.0'), /грязн/)
})
test('даунгрейд требует --allow-downgrade', () => {
  assert.throws(() => checkoutBoardRef(project, 'v1.0.0'), /allow-downgrade/)
})
```

- [ ] **Step 5: Прогнать**

Run: `node --test tests/core/git.test.ts`
Expected: PASS.

- [ ] **Step 6: Коммит**

```bash
git add src/core/git.ts tests/core/git.test.ts tests/helpers/git.ts
git commit -m "feat: board submodule operations"
```

---

### Task 3: `board init` с submodule

**Files:**
- Modify: `src/core/project.ts` (`initProject` options)
- Modify: `src/cli/commands/init.ts` (`--board-version`, `--board-source`)
- Test: `tests/core/project.test.ts`, `tests/cli/init-board.test.ts` (новый)

**Interfaces:**
- `initProject(dir, { refresh?, boardVersion?: string, boardSource?: string })`.
- Self-case: `isBoardSourceRepo(root)` → submodule не добавлять, генерировать локально.
- Иначе: нет `tools/board` → `addBoardSubmodule(root, source, version ?? latestBoardTag(source))`; есть → проверить состояние и при `boardVersion` вызвать `checkoutBoardRef`.
- После установки submodule — запустить `node tools/board/bin/board.ts init --refresh` с `BOARD_DELEGATED=1` и `cwd=root`; глобальный init не генерирует файлы из своей версии.

- [ ] **Step 1: CLI-тест**

```ts
test('init добавляет submodule и генерирует .opencode', () => {
  const source = makeBoardSource(dir)
  const out = json(dir, ['init', '--board-version', 'v1.0.0', '--board-source', source])
  assert.equal(out.boardVersion, '1.0.0')
  assert.ok(existsSync(join(dir, 'tools', 'board', 'bin', 'board.ts')))
  assert.ok(existsSync(join(dir, '.opencode', 'plugins', 'board', 'index.ts')))
  assert.equal(boardSubmoduleState(dir), 'ready')
})
```

- [ ] **Step 2: Запустить и убедиться, что падает**

Run: `node --test tests/cli/init-board.test.ts`
Expected: FAIL — неизвестные флаги, submodule не создаётся.

- [ ] **Step 3: Реализовать**

`init.ts` читает флаги и передаёт в `initProject`; `ok` печатает `{ root, created, updated, boardVersion }`.
`project.ts` — логика выше. Для spawn использовать `execFileSync(process.execPath, [local, 'init', '--refresh'], { cwd: root, env: { ...process.env, BOARD_DELEGATED: '1' } })`.
Если `boardVersion` не задан и source недоступен — `UserError(2, 'нужен --board-version или доступный source')`.

- [ ] **Step 4: Тест self-case**

```ts
test('init в репозитории board не добавляет submodule', () => {
  const root = tempBoardSourceRepo()
  initProject(root, { refresh: true })
  assert.equal(existsSync(join(root, 'tools', 'board')), false)
})
```

- [ ] **Step 5: Прогнать**

Run: `node --test tests/core/project.test.ts tests/cli/init-board.test.ts`
Expected: PASS.

- [ ] **Step 6: Коммит**

```bash
git add src/core/project.ts src/cli/commands/init.ts tests/core/project.test.ts tests/cli/init-board.test.ts
git commit -m "feat: init installs project board submodule"
```

---

### Task 4: `board upgrade`

**Files:**
- Create: `src/cli/commands/upgrade.ts`
- Modify: `src/core/git.ts` (если нужен `upgradeBoard`)
- Modify: `bin/board.ts` (help, команда)
- Test: `tests/cli/upgrade.test.ts`

**Interfaces:**
- `board upgrade <ref> [--latest] [--allow-downgrade]`.
- `board upgrade --latest` — `latestBoardTag(source)` из `.gitmodules`.
- Порядок: `checkoutBoardRef` → `initProject(root, { refresh: true })` → печать нового указателя.

- [ ] **Step 1: Тест**

```ts
test('upgrade переключает submodule и перегенерирует .opencode', () => {
  const source = makeBoardSource(dir) // v1.0.0 и v1.1.0
  initProject(dir, { boardVersion: 'v1.0.0', boardSource: source })
  const out = json(dir, ['upgrade', 'v1.1.0'])
  assert.equal(out.boardVersion, '1.1.0')
  assert.match(readFileSync(join(dir, '.opencode', 'plugins', 'board', 'index.ts'), 'utf8'), /1\.1\.0|tools/)
})
```

- [ ] **Step 2: Запустить и убедиться, что падает**

Run: `node --test tests/cli/upgrade.test.ts`
Expected: FAIL — неизвестная команда.

- [ ] **Step 3: Реализовать**

Команда читает ref/`--latest`, вызывает `checkoutBoardRef`, затем `initProject(root, { refresh: true })`. Если запущена из глобальной версии без локального submodule — `UserError(2, 'сначала board init')`. `--allow-downgrade` пробрасывается.

- [ ] **Step 4: Тест отказа на грязном submodule**

```ts
test('upgrade на грязном submodule отказывает', () => {
  writeFileSync(join(dir, 'tools', 'board', 'dirty.txt'), 'x')
  const out = run(dir, ['upgrade', 'v1.1.0'])
  assert.equal(out.code, 2)
  assert.match(out.err, /грязн/)
})
```

- [ ] **Step 5: Прогнать**

Run: `node --test tests/cli/upgrade.test.ts`
Expected: PASS.

- [ ] **Step 6: Коммит**

```bash
git add src/cli/commands/upgrade.ts bin/board.ts tests/cli/upgrade.test.ts
git commit -m "feat: board upgrade command"
```

---

### Task 5: Глобальный диспетчер

**Files:**
- Modify: `bin/board.ts`
- Test: `tests/cli/dispatcher.test.ts`

**Interfaces:**
- До `main`: если нет `--global` и нет `BOARD_DELEGATED` и `findLocalBoardCli(root)` не равен текущему файлу — `spawnSync(process.execPath, [local, ...argv], { stdio: 'inherit', env: { ...process.env, BOARD_DELEGATED: '1' } })`, вернуть его код.
- `init --board-version` всегда идёт в глобальную версию (пропустить делегирование).
- Без локального CLI: `init`, `doctor`, `--version`, `help` — глобально; остальные команды — `UserError(2, 'board не установлен: выполните board init')`.
- `--global` вырезается из argv и запускает глобальную версию.

- [ ] **Step 1: Тест диспетчера**

```ts
test('глобальный board делегирует локальному CLI', () => {
  const project = tempGitProject()
  mkdirSync(join(project, 'tools', 'board', 'bin'), { recursive: true })
  writeFileSync(join(project, 'tools', 'board', 'bin', 'board.ts'), "console.log('LOCAL')\n")
  const out = spawnSync(process.execPath, [repoBin, 'now'], { cwd: project, encoding: 'utf8' })
  assert.equal(out.stdout.trim(), 'LOCAL')
})
test('--global обходит делегирование', () => {
  const out = spawnSync(process.execPath, [repoBin, '--global', '--version'], { cwd: project, encoding: 'utf8' })
  assert.notEqual(out.stdout.trim(), 'LOCAL')
})
```

- [ ] **Step 2: Запустить и убедиться, что падает**

Run: `node --test tests/cli/dispatcher.test.ts`
Expected: FAIL — глобальный код выполняется сам.

- [ ] **Step 3: Реализовать**

В начале `bin/board.ts`:
```ts
const argv = process.argv.slice(2)
const globalFlag = argv.includes('--global')
const args = argv.filter((arg) => arg !== '--global')
const root = findProjectRootForCli(process.cwd())
const local = root ? findLocalBoardCli(root) : null
const self = realpathSync(fileURLToPath(import.meta.url))
if (!globalFlag && !process.env.BOARD_DELEGATED && local && realpathSync(local) !== self && !isInstallerOverride(args)) {
  const result = spawnSync(process.execPath, [local, ...args], { stdio: 'inherit', env: { ...process.env, BOARD_DELEGATED: '1' } })
  process.exit(result.status ?? 3)
}
```
`isInstallerOverride(args)` — `args[0] === 'init' && args.includes('--board-version')`.
`findProjectRootForCli` — вверх от cwd до `.board`/`.git`; можно вынести в `git.ts` и покрыть тестом.
Для операционных команд без local — ошибка; для `init`/`doctor`/`--version`/`help` — продолжить глобально.

- [ ] **Step 4: Прогнать**

Run: `node --test tests/cli/dispatcher.test.ts`
Expected: PASS.

- [ ] **Step 5: Коммит**

```bash
git add bin/board.ts src/core/git.ts tests/cli/dispatcher.test.ts
git commit -m "feat: global board dispatcher"
```

---

### Task 6: Плагин и тексты `.opencode`

**Files:**
- Modify: `src/core/opencode.ts` (`PLUGIN_SOURCE.resolveCli`, `AGENTS_SOURCE`, skill text)
- Modify: `.opencode/plugins/board/index.ts` (сгенерировать)
- Modify: `.opencode/skills/board/SKILL.md` (сгенерировать)
- Test: `tests/core/opencode.test.ts`

**Interfaces:**
- `resolveCli(ctx)`:
```js
const root = resolveProjectRoot(ctx.location.directory)
const local = [
  join(root, 'tools', 'board', 'bin', 'board.ts'),
  join(root, 'bin', 'board.ts'),
].find(existsSync)
if (local) return { file: nodeBin, args: [local] }
if (process.env.BOARD_CLI) return { file: nodeBin, args: [process.env.BOARD_CLI] }
throw new Error('board не установлен: выполните board init')
```
- `resolveProjectRoot` — `ctx.location.project?.canonical` или подъём до `.board`/`.git`.

- [ ] **Step 1: Тест шаблона**

```ts
test('плагин ищет tools/board раньше BOARD_CLI', () => {
  const local = PLUGIN_SOURCE.indexOf("'tools', 'board'")
  const override = PLUGIN_SOURCE.indexOf('BOARD_CLI')
  assert.ok(local > 0 && local < override)
})
```

- [ ] **Step 2: Запустить и убедиться, что падает**

Run: `node --test tests/core/opencode.test.ts`
Expected: FAIL — порядок другой.

- [ ] **Step 3: Реализовать и перегенерировать**

Обновить `PLUGIN_SOURCE` и `AGENTS_SOURCE`: «board — локальный `tools/board`, `BOARD_CLI` только override».
Запустить `node bin/board.ts init --refresh` в корне репозитория; проверить diff `.opencode`.

- [ ] **Step 4: Прогнать**

Run: `node --test tests/core/opencode.test.ts tests/core/project.test.ts`
Expected: PASS.

- [ ] **Step 5: Коммит**

```bash
git add src/core/opencode.ts .opencode/plugins/board/index.ts .opencode/skills/board/SKILL.md tests/core/opencode.test.ts
git commit -m "feat: plugin resolves project-local board"
```

---

### Task 7: Superpowers по проектам

**Files:**
- Create: `.opencode/opencode.json`
- Modify: `C:\Users\aleks\.config\opencode\opencode.json` (вне репозитория)
- Modify: `README.md`, `docs/board/terminology.md`
- Test: `tests/core/opencode.test.ts` (файл проекта)

**Interfaces:**
- Глобальный `opencode.json`: удалить запись superpowers из `plugins`, сохранить остальное.
- `.opencode/opencode.json`:
```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["C:\\Users\\aleks\\.config\\opencode\\node_modules\\superpowers"]
}
```

- [ ] **Step 1: Тест файла проекта**

```ts
test('проект подключает superpowers локально', () => {
  const config = JSON.parse(readFileSync(join(root, '.opencode', 'opencode.json'), 'utf8'))
  assert.ok(config.plugins.some((entry: string) => entry.includes('superpowers')))
})
```

- [ ] **Step 2: Создать файл и удалить глобальную запись**

Node-скрипт: прочитать глобальный JSON, отфильтровать `plugins` без `superpowers`, записать обратно с отступом 2. Если `plugins` пуст — удалить ключ.

- [ ] **Step 3: Обновить README/terminology**

Описать: superpowers не глобальный; проект добавляет его в `.opencode/opencode.json`; brainstorming доступен только там; в проекте с superpowers можно запретить `brainstorming` через `permissions`.

- [ ] **Step 4: Проверка**

Run: `node --test tests/core/opencode.test.ts`
Expected: PASS.
Вручную: список скиллов в проекте без записи не содержит superpowers; в этом проекте — содержит после reload.

- [ ] **Step 5: Коммит**

```bash
git add .opencode/opencode.json README.md docs/board/terminology.md tests/core/opencode.test.ts
git commit -m "feat: superpowers opt-in per project"
```

---

### Task 8: Версия, релиз и тег

**Files:**
- Modify: `package.json` (`version` 1.2.0)
- Modify: `README.md` (раздел про версии/submodule)
- Test: `tests/cli/help.test.ts` (версия из package.json)

**Interfaces:**
- `package.json` 1.2.0; тег `v1.2.0` на релизном коммите `main`.

- [ ] **Step 1: Поднять версию**

`package.json` → `"version": "1.2.0"`.

- [ ] **Step 2: Прогнать полный набор**

Run: `node --test`
Expected: PASS, все тесты.

- [ ] **Step 3: Коммит**

```bash
git add package.json README.md
git commit -m "chore: release 1.2.0"
```

- [ ] **Step 4: Владелец**

`board release` → `git tag v1.2.0` → `git push origin dev main --tags`.
После тега другие проекты могут пинить `v1.2.0` через `board init --board-version v1.2.0`.

---

## Self-Review

- Spec coverage: резолв (1), submodule (2), init (3), upgrade (4), диспетчер (5), плагин (6), superpowers (7), версия/тег (8).
- Типы: `BoardSubmoduleState` из Task 2 используется в 3–4; `findLocalBoardCli` из 1 — в 3 и 5.
- Review Focus: worktree (1/5), self-init (3), сломанный CLI (5), грязный submodule (4), даунгрейд (2/4), молчаливый глобальный запуск (5).
