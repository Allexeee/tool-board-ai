# toolbox-al: git и слияние — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Приложение само ведёт ветки и коммиты: worktree на фичу, коммит на задачу, слияние этапа в `dev`, релиз в `main` с changelog и тегом.

**Architecture:** Git-операции — отдельный слой поверх существующего ядра: `src/core/git/` знает про ветки и worktree, но не про задачи; слияние и релиз читают состояние из базы и вызывают git. Все команды git идут через один `runGit`, который бросает `GitError` с stderr вместо падения стека. В git пишет только приложение, агенты — никогда.

**Tech Stack:** Node 26, TypeScript без сборки, `node:sqlite`, `node:child_process` (`execFileSync`), `node:test`.

**Spec:** `docs/specs/2026-11-16-toolbox-al-design.md` (разделы 7, 12, `G-1`–`G-12`, `L-5`, `D-5`)

## Global Constraints

- Node 26, TypeScript без сборки, ноль внешних зависимостей.
- Все вызовы git — через `runGit(cwd, args)`; прямых `execFileSync('git', …)` в ядре нет.
- Коммит делает приложение. Сообщение: `<task-id>: <title>`; тело — отчёт.
- Задача коммитит только файлы своего `scope`; глоб — через pathspec `:(glob)<pattern>`.
- Слияние идёт только в `dev`; `main` трогает только `release`.
- Имена веток — из конфига; при наличии `develop` и отсутствии `dev` берётся `develop`.
- Все новые мутации — в транзакции и с записью в `events`.
- Коды возврата: `0` успех, `1` нечего делать, `3` ошибка.

## Review Focus

1. **Проект не является git-репозиторием.** Ожидание: `feature start` и `stage merge` дают внятную ошибку «это не git-репозиторий», а не стек вызовов.
2. **Ветки `dev` нет.** Ожидание: `stage merge` говорит, какую ветку создать и от чего, и ничего не сливает в `main`.
3. **В задаче нет изменений в её `scope`.** Ожидание: `done` закрывает задачу без коммита, а не падает на пустом `git commit`.
4. **Конфликт при слиянии этапа.** Ожидание: слияние отменено, дерево не в состоянии merge, создана задача `conflict` класса expedite.
5. **Задачи закрыты, но проверка падает.** Ожидание: этап не слит и не помечен `merged`; вывод называет упавшую команду.

## Фикстуры тестов

Живут в `tests/helpers/repo.ts` и `tests/helpers/feature.ts`, чтобы задачи не изобретали их заново.

- `makeRepo(): string` — временный каталог, `git init -b main`, локальные `user.name`/`user.email`, `README.md`, первый коммит, ветка `dev`.
- `repoWithDb(dir): Project` — `initProject` + `openDb`, возвращает `{ root, db, config }`.
- `fixtureWithWorktree()` — репозиторий, фича F1, этап F1.S1 активен, одна задача, `startFeature` вызван; возвращает `{ db, root, worktree, task, feature }`.
- `startedFeature()` — то же, что `fixtureWithWorktree`, без коммита задачи.
- `mergedReadyStage(options?: { check?: string; skipDev?: boolean })` — фикстура выше + задача закрыта (`doneTask`) + `setFeatureCheck`; при `skipDev` ветка `dev` не создаётся.
- `conflictingStage()` — две фичи с одним файлом `src/a.ts`, обе слиты в `dev` по очереди, затем правка того же файла в ветке второй фичи так, что слияние конфликтует.

---

### Task 1: Git-контекст и имена веток

**Files:**
- Create: `src/core/git/git.ts`
- Test: `tests/git/git.test.ts`, `tests/helpers/repo.ts`

**Interfaces:**
- Produces: `runGit(cwd: string, args: string[], env?: Record<string,string>): string` — trimmed stdout, бросает `GitError` с `code: 3` и stderr
- Produces: `isRepo(dir: string): boolean`
- Produces: `currentBranch(dir: string): string | null`
- Produces: `branchExists(dir: string, name: string): boolean`
- Produces: `resolveBranches(dir: string, config: { branches: { main: string; dev: string } }): { main: string; dev: string }`
- Produces (test helper): `makeRepo(): string` — temp dir, `git init`, локальные `user.name`/`user.email`, первый коммит с `README.md`

- [ ] **Step 1: Write the failing test**

```ts
test('resolveBranches берёт develop, если есть только он', () => {
  const dir = makeRepo()
  runGit(dir, ['branch', 'develop'])
  assert.deepEqual(resolveBranches(dir, config), { main: 'main', dev: 'develop' })
})

test('не-репозиторий даёт понятную ошибку', () => {
  const dir = mkdtempSync(join(tmpdir(), 'norepo-'))
  assert.equal(isRepo(dir), false)
  assert.throws(() => runGit(dir, ['status']), /не git-репозиторий/)
})

test('currentBranch возвращает имя ветки', () => {
  const dir = makeRepo()
  assert.ok(currentBranch(dir))
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/git/git.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement `runGit` and branch helpers**

`runGit` использует `execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore','pipe','pipe'] })`; при ошибке кладёт stderr в сообщение. `isRepo` — `git rev-parse --is-inside-work-tree`. `resolveBranches`: если `config.branches.dev` не существует, но существует `develop` — вернуть `develop`; если не существует ни один — вернуть значение конфига (ошибку даёт слияние, не эта функция).

- [ ] **Step 4: Run** `node --test tests/git/` → PASS

- [ ] **Step 5: Commit**

```bash
git add src/core/git tests/git tests/helpers
git commit -m "feat: git runner and branch resolution"
```

---

### Task 2: Защита main и dev

**Files:**
- Create: `src/core/git/hooks.ts`
- Test: `tests/git/hooks.test.ts`

**Interfaces:**
- Produces: `installHooks(gitDir: string): { installed: string[] }` — пишет `.git/hooks/pre-commit`, идемпотентно
- Produces: `hookInstalled(gitDir: string): boolean`
- Поведение хука: если текущая ветка равна одной из `$AL_PROTECTED` (список через запятую) и `AL_ALLOW` не равен `1` — выход с кодом 1 и сообщением.

- [ ] **Step 1: Write the failing test**

```ts
test('хук ставится и запрещает коммит в защищённую ветку', () => {
  const dir = makeRepo()
  const { installed } = installHooks(join(dir, '.git'), { protectedBranches: ['main', 'dev'] })
  assert.deepEqual(installed, ['pre-commit'])

  writeFileSync(join(dir, 'a.txt'), 'x')
  runGit(dir, ['add', 'a.txt'])
  assert.throws(() => runGit(dir, ['commit', '-m', 'x', '--no-verify']), /./) // sanity: --no-verify обходит
  assert.throws(() => runGit(dir, ['commit', '-m', 'x'], { AL_PROTECTED: 'main' }), /защищённ/)
})

test('AL_ALLOW=1 пропускает коммит', () => {
  const dir = makeRepo()
  installHooks(join(dir, '.git'), { protectedBranches: ['main'] })
  writeFileSync(join(dir, 'b.txt'), 'x')
  runGit(dir, ['add', 'b.txt'])
  runGit(dir, ['commit', '-m', 'ok'], { AL_PROTECTED: 'main', AL_ALLOW: '1' })
  assert.match(runGit(dir, ['log', '-1', '--pretty=%s']), /ok/)
})
```

- [ ] **Step 2: Run** → FAIL

- [ ] **Step 3: Implement `installHooks`**

`pre-commit` — POSIX sh-скрипт: читает `git symbolic-ref --short HEAD`, сравнивает с `$AL_PROTECTED`, уважает `AL_ALLOW=1`. Существующий хук не перезаписывается: рядом создаётся `pre-commit.toolbox-al`, и в существующий добавляется вызов, если его там нет. `installHooks` возвращает список созданных файлов.

- [ ] **Step 4: Run** → PASS

- [ ] **Step 5: Commit**

```bash
git add src/core/git/hooks.ts tests/git/hooks.test.ts
git commit -m "feat: pre-commit hook protecting main and dev"
```

---

### Task 3: Схема v3 и команда проверки

**Files:**
- Modify: `src/core/schema.ts`, `src/core/config.ts`, `src/core/features.ts`
- Test: `tests/core/schema3.test.ts`

**Interfaces:**
- Produces: `SCHEMA_VERSION = 3`; миграция добавляет `features.branch text`, `features.worktree text`, `stages.merged_at text`, таблицу `releases(id, version, tag, changelog, at)`
- Produces: `Feature.branch: string | null`, `Feature.worktree: string | null`
- Produces: `setFeatureCheck(db, featureId, checkCmd: string | null): void`
- Produces: `Config.check: string | null` (по умолчанию `null`)

- [ ] **Step 1: Write the failing test**

```ts
test('миграция v3 добавляет ветку, worktree и релизы', () => {
  const db = openDb(':memory:')
  assert.equal(migrate(db), 3)
  const cols = db.prepare("pragma table_info(features)").all().map((c: any) => c.name)
  assert.ok(cols.includes('branch') && cols.includes('worktree'))
  const tables = db.prepare("select name from sqlite_master where type='table'").all().map((r: any) => r.name)
  assert.ok(tables.includes('releases'))
})

test('check фичи сохраняется', () => {
  const db = openDb(':memory:')
  const feature = addFeature(db, { name: 'A', rank: 1 })
  setFeatureCheck(db, feature.id, 'npm test')
  assert.equal(getFeature(db, feature.id)!.checkCmd, 'npm test')
})
```

- [ ] **Step 2: Run** → FAIL

- [ ] **Step 3: Implement migration v3**

Порядок: `if (from < 3) { alter table features add column branch text; … create table releases … }`. `openDb` на базе версии 2 должен доехать до 3 без потери данных — покрыть это отдельным тестом на временном файле: создать базу, закрыть, открыть снова.

- [ ] **Step 4: Run** → PASS

- [ ] **Step 5: Commit**

```bash
git add src/core tests/core/schema3.test.ts
git commit -m "feat: schema v3 for branches, worktrees and releases"
```

---

### Task 4: `feature start` — ветка и worktree

**Files:**
- Create: `src/core/git/worktree.ts`, `src/cli/commands/feature-start.ts`
- Modify: `src/cli/commands/feature.ts` (подкоманда `start`)
- Test: `tests/git/worktree.test.ts`

**Interfaces:**
- Consumes: `runGit`, `resolveBranches`, `slugify`, `getFeature`, `setFeatureBranch`
- Produces: `startFeature(db, { root, featureId, config }): { branch: string; worktree: string }`
- Produces: `worktreePath(root: string, slug: string): string` — `<root>/.worktrees/<slug>`
- Производит побочный эффект: `git worktree add <path> -b feat/<slug>` от `dev`

- [ ] **Step 1: Write the failing test**

```ts
test('feature start создаёт ветку и рабочий каталог', () => {
  const dir = makeRepo()
  const db = openDb(join(dir, '.toolbox-al/tracker.db'))
  const feature = addFeature(db, { name: 'Оплата подписки', rank: 1 })

  const result = startFeature(db, { root: dir, featureId: feature.id, config })
  assert.equal(result.branch, 'feat/f1-oplata-podpiski')
  assert.ok(existsSync(join(result.worktree, '.git')))
  assert.equal(currentBranch(result.worktree), result.branch)
})

test('повторный feature start возвращает то же и не ломается', () => {
  const first = startFeature(db, { root: dir, featureId: feature.id, config })
  const second = startFeature(db, { root: dir, featureId: feature.id, config })
  assert.deepEqual(second, first)
})
```

- [ ] **Step 2: Run** → FAIL

- [ ] **Step 3: Implement**

Идемпотентность: если `features.branch` уже записан и каталог существует — вернуть как есть. Если записан, а каталога нет — `git worktree add <path> <branch>`. Слаг — от имени фичи с префиксом id: `f<номер>-<slug>`.

- [ ] **Step 4: Run** → PASS

- [ ] **Step 5: Commit**

```bash
git add src/core/git src/cli/commands tests/git
git commit -m "feat: feature worktree and branch"
```

---

### Task 5: Коммит задачи и черновик

**Files:**
- Create: `src/core/git/commit.ts`
- Modify: `src/core/done.ts`
- Test: `tests/git/commit.test.ts`

**Interfaces:**
- Produces: `commitTask({ worktree, task, report }): string | null` — `git add -- :(glob)<scope>`; коммит `<id>: <title>`; `null`, если добавить нечего
- Produces: `saveDraft({ worktree, task, summary }): string | null`
- Изменяет: `doneTask` вызывает `commitTask`, если задача привязана к фиче с worktree; sha пишется в `events`

- [ ] **Step 1: Write the failing test**

```ts
test('done коммитит только файлы своей области', () => {
  const { db, worktree, task } = fixtureWithWorktree()
  writeFileSync(join(worktree, 'src/a.ts'), 'a')
  writeFileSync(join(worktree, 'docs/b.md'), 'b')

  const sha = commitTask({ worktree, task: { ...task, scope: ['src/**'] }, report: { summary: 's', checks: [] } })
  assert.ok(sha)

  const files = runGit(worktree, ['show', '--name-only', '--pretty=', sha!]).trim().split('\n')
  assert.deepEqual(files, ['src/a.ts'])
  assert.match(runGit(worktree, ['status', '--porcelain']), /docs\/b.md/)
})

test('пустой diff не создаёт коммит и не падает', () => {
  const { worktree, task } = fixtureWithWorktree()
  assert.equal(commitTask({ worktree, task, report: { summary: 's', checks: [] } }), null)
})

test('save пишет черновик', () => {
  const { worktree, task } = fixtureWithWorktree()
  writeFileSync(join(worktree, 'src/a.ts'), 'a')
  const sha = saveDraft({ worktree, task, summary: 'половина' })
  assert.match(runGit(worktree, ['log', '-1', '--pretty=%s', sha!]), /wip:/)
})
```

- [ ] **Step 2: Run** → FAIL

- [ ] **Step 3: Implement**

`git add -- :(glob)src/**` не падает, если файлов нет. Перед коммитом проверять `git diff --cached --quiet`; если пусто — вернуть `null`. Тело коммита: `summary` и `checks` из отчёта.

- [ ] **Step 4: Run** → PASS

- [ ] **Step 5: Commit**

```bash
git add src/core/git src/core/done.ts tests/git
git commit -m "feat: per-task commits limited to scope"
```

---

### Task 6: Пересечение областей блокирует параллельную работу

**Files:**
- Modify: `src/core/lease.ts`
- Create: `src/core/git/scope.ts`
- Test: `tests/core/scope.test.ts`

**Interfaces:**
- Produces: `scopesOverlap(a: TaskScope, b: TaskScope): boolean` — `exclusive` пересекается со всем; иначе совпадение или префикс пути
- Изменяет: `takeTask` при взятии в фиче с worktree отклоняет задачу, если активная задача той же фичи имеет пересекающуюся область

- [ ] **Step 1: Write the failing test**

```ts
test('exclusive пересекается со всем', () => {
  assert.equal(scopesOverlap('exclusive', ['src/a']), true)
  assert.equal(scopesOverlap(['src/a'], 'exclusive'), true)
})

test('разные каталоги не пересекаются', () => {
  assert.equal(scopesOverlap(['assets/sprites/**'], ['src/enemy/**']), false)
})

test('вложенный путь пересекается', () => {
  assert.equal(scopesOverlap(['src/**'], ['src/billing/a.ts']), true)
})

test('вторая задача с пересечением не берётся', () => {
  // две задачи в одном этапе, scope пересекается, первый взял — второй получает код 1
  assert.throws(() => takeTask(db, { executor: 'w2', taskId: second.id }), /область/)
})
```

- [ ] **Step 2: Run** → FAIL

- [ ] **Step 3: Implement**

Нормализация: снять `@`, заменить `**` на `*`, сравнить по сегментам. Пересечение — если один путь является префиксом другого или они равны.

- [ ] **Step 4: Run** → PASS

- [ ] **Step 5: Commit**

```bash
git add src/core tests/core
git commit -m "feat: scope conflicts serialize parallel work"
```

---

### Task 7: Слияние этапа

**Files:**
- Create: `src/core/git/merge.ts`, `src/cli/commands/stage-merge.ts`
- Modify: `src/core/stages.ts`, `src/cli/commands/stage.ts`
- Test: `tests/git/merge.test.ts`

**Interfaces:**
- Produces: `mergeStage(db, { root, stageId, config }): { merged: boolean; commit?: string; reason?: string }`
- Условие: все задачи этапа `done`; `feature.checkCmd` (или `config.check`) выполнен в worktree с кодом 0; ветка `dev` существует
- Побочные эффекты: `git merge --no-ff` из `dev`, затем `stages.status='merged'`, `merged_at`, активация следующего этапа, событие

- [ ] **Step 1: Write the failing test**

```ts
test('этап сливается в dev и активирует следующий', () => {
  const { db, root, stageId, worktree } = mergedReadyStage()
  writeFileSync(join(worktree, 'src/a.ts'), 'a')
  commitTask(...)

  const result = mergeStage(db, { root, stageId, config })
  assert.equal(result.merged, true)
  assert.equal(getStage(db, stageId)!.status, 'merged')
  assert.match(runGit(root, ['log', 'dev', '--oneline']), new RegExp(result.commit!.slice(0, 7)))
})

test('упавшая проверка не сливает этап', () => {
  const { db, root, stageId } = mergedReadyStage({ check: 'node -e "process.exit(1)"' })
  const result = mergeStage(db, { root, stageId, config })
  assert.equal(result.merged, false)
  assert.match(result.reason ?? '', /проверка/)
  assert.equal(getStage(db, stageId)!.status, 'active')
})

test('нет ветки dev — понятная ошибка', () => {
  const { db, root, stageId } = mergedReadyStage({ skipDev: true })
  assert.throws(() => mergeStage(db, { root, stageId, config }), /ветк/)
})
```

- [ ] **Step 2: Run** → FAIL

- [ ] **Step 3: Implement**

Проверка командой `sh -c` на Windows — `process.platform === 'win32' ? 'cmd.exe /c' : 'sh -c'`. Слияние выполняется в главном дереве: `git checkout dev` не нужен — используется `git -C <root> merge --no-ff feat/<slug>` после `git -C <root> checkout dev`, затем возврат на исходную ветку.

- [ ] **Step 4: Run** → PASS

- [ ] **Step 5: Commit**

```bash
git add src/core/git src/cli/commands tests/git
git commit -m "feat: stage merge into dev with check gate"
```

---

### Task 8: Конфликт слияния становится задачей

**Files:**
- Modify: `src/core/git/merge.ts`
- Test: `tests/git/conflict.test.ts`

**Interfaces:**
- Produces: при конфликте `mergeStage` возвращает `{ merged: false, reason: 'конфликт', taskId }` и создаёт задачу `conflict` класса `expedite` в этапе, с `scope` из конфликтующих файлов
- Гарантия: `runGit(root, ['merge', '--abort'])` вызван до создания задачи; дерево чистое

- [ ] **Step 1: Write the failing test**

```ts
test('конфликт отменяет merge и создаёт срочную задачу', () => {
  const ctx = conflictingStage()
  const result = mergeStage(db, { root, stageId, config })
  assert.equal(result.merged, false)
  assert.match(result.reason ?? '', /конфликт/)

  const task = getTask(db, result.taskId!)
  assert.equal(task.class, 'expedite')
  assert.match(task.title, /конфликт/i)

  assert.equal(runGit(root, ['status', '--porcelain']).trim(), '')
})
```

- [ ] **Step 2: Run** → FAIL

- [ ] **Step 3: Implement**

Конфликтующие файлы: `git diff --name-only --diff-filter=U`. Если `--abort` сам падает — писать в журнал `merge.abort_failed` и всё равно создавать задачу, чтобы человек увидел.

- [ ] **Step 4: Run** → PASS

- [ ] **Step 5: Commit**

```bash
git add src/core/git tests/git/conflict.test.ts
git commit -m "feat: merge conflicts become expedite tasks"
```

---

### Task 9: Релиз

**Files:**
- Create: `src/core/git/release.ts`, `src/cli/commands/release.ts`
- Test: `tests/git/release.test.ts`

**Interfaces:**
- Produces: `release(db, { root, level: 'major'|'minor'|'patch', config, actor }): { version: string; tag: string; changelog: string }`
- Источник changelog: этапы `merged` без записи в `releases`; строка на этап: `<feature name> — <stage name>`
- Побочные эффекты: `git checkout main && git merge --no-ff dev`, bump версии в `meta` (`version`), запись в `CHANGELOG.md`, коммит `chore: release vX.Y.Z`, тег `vX.Y.Z`, запись в `releases`

- [ ] **Step 1: Write the failing test**

```ts
test('релиз собирает changelog из этапов и ставит тег', () => {
  const { db, root } = repoWithMergedStage()
  const result = release(db, { root, level: 'minor', config, actor: 'owner' })

  assert.equal(result.version, '0.2.0')
  assert.equal(result.tag, 'v0.2.0')
  assert.match(result.changelog, /Оплата/)
  assert.match(readFileSync(join(root, 'CHANGELOG.md'), 'utf8'), /v0\.2\.0/)
  assert.match(runGit(root, ['tag']), /v0\.2\.0/)
  assert.match(runGit(root, ['log', 'main', '-1', '--pretty=%s']), /release v0\.2\.0/)
})

test('повторный релиз без новых этапов ничего не выпускает', () => {
  // второй вызов возвращает merged=false и не двигает тег
})
```

- [ ] **Step 2: Run** → FAIL

- [ ] **Step 3: Implement**

Версия — semver в `meta.version`, старт `0.1.0`. Bump: major/minor/patch. `CHANGELOG.md`: заголовок `## vX.Y.Z — <дата>` и список этапов; старые записи не теряются.

- [ ] **Step 4: Run** → PASS

- [ ] **Step 5: Commit**

```bash
git add src/core/git src/cli/commands tests/git
git commit -m "feat: release with changelog, tag and version bump"
```

---

### Task 10: `feature abandon`, `doctor` и README

**Files:**
- Modify: `src/core/features.ts`, `src/core/doctor.ts`, `src/cli/commands/feature.ts`, `README.md`
- Test: `tests/git/abandon.test.ts`, `tests/core/doctor.test.ts`

**Interfaces:**
- Produces: `abandonFeature(db, { featureId, actor, reason }): Feature` — задачи `cancelled`, этапы `abandoned`, фича `cancelled`, worktree остаётся, ветка не сливается
- Produces: проверки `doctor`: `git-хук установлен`, `dev существует`, `рабочие каталоги фич на месте`

- [ ] **Step 1: Write the failing test**

```ts
test('abandon закрывает задачи и не сливает ветку', () => {
  const { db, featureId, root } = startedFeature()
  const feature = abandonFeature(db, { featureId, actor: 'owner', reason: 'передумали' })
  assert.equal(feature.status, 'cancelled')
  assert.equal(listTasks(db, { stageId: 'F1.S1' }).every(t => t.status === 'cancelled'), true)
  assert.equal(runGit(root, ['branch', '--list', 'feat/*']).includes('feat/'), true)
})

test('doctor замечает отсутствие хука и ветки dev', () => {
  const report = doctorReport(db, { root })
  assert.ok(report.checks.some(c => c.name === 'git-хук' && !c.ok))
  assert.ok(report.checks.some(c => c.name === 'ветка dev' && !c.ok))
})
```

- [ ] **Step 2: Run** → FAIL

- [ ] **Step 3: Implement**

`abandonFeature` не удаляет каталог: работа может понадобиться. `doctor` принимает `{ root }` опционально; без него git-проверки пропускаются.

- [ ] **Step 4: Run** → PASS

- [ ] **Step 5: Commit**

```bash
git add src README.md tests
git commit -m "feat: abandon, doctor git checks and docs"
```

---

## Что этот план сознательно не делает

- Не делает merge request'ы и не работает с удалённым репозиторием: только локальный git.
- Не запускает CI: проверка — локальная команда из конфига.
- Не разрешает конфликты автоматически: конфликт — это задача человеку или агенту.
- Не трогает `main` ничем, кроме `release`.

## Проверка готовности плана 2

- [ ] Существующая база версии 2 доезжает до 3 без потери данных
- [ ] `feature start` идемпотентен
- [ ] `done` коммитит только файлы `scope` и не падает на пустом diff
- [ ] Пересечение областей блокирует параллельный захват
- [ ] Этап не сливается без зелёной проверки и без ветки `dev`
- [ ] Конфликт отменяет merge и создаёт срочную задачу
- [ ] Релиз собирает changelog из этапов, ставит тег и не дублирует версию
- [ ] Хук не пускает коммит в `main` и `dev`
- [ ] `abandon` не сливает ветку и закрывает задачи
