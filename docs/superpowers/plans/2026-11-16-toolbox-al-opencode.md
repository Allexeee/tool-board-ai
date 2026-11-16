# toolbox-al: OpenCode — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Инструмент встраивается в OpenCode: плагин с нативными инструментами, скилл с командами, первичная настройка силами агента.

**Architecture:** Плагин — тонкая обёртка: он не содержит бизнес-логики и вызывает CLI через `execFile`. Скилл объясняет агенту порядок работы. `init` пишет файлы идемпотентно, между маркерами.

**Tech Stack:** Node 26, TypeScript, `@opencode/plugin` (V2), `node:test`.

**Spec:** `docs/specs/2026-11-16-toolbox-al-design.md` (раздел 11; `O-1`–`O-18`)

## Global Constraints

- Плагин не содержит логики: только вызов `node bin/toolbox-al.ts … --json` и разбор вывода.
- Все инструменты возвращают JSON-строку; ошибки — текст CLI.
- Ни один инструмент не запускает модель.
- `init` не перезаписывает существующие файлы и не дублирует блоки.
- Версия API плагина — V2 (`Plugin.define`).

## Review Focus

1. **Повторный `init`.** Ожидание: ни один файл не перезаписан, блок в `AGENTS.md` не задублирован.
2. **Плагин без CLI.** Ожидание: инструмент возвращает внятную ошибку, а не падает.
3. **Владелец без `--confirm`.** Ожидание: инструменты владельца отвергают действие.

---

### Task 1: Генерация файлов OpenCode

**Files:**
- Create: `src/core/opencode.ts`, `src/cli/commands/init.ts` (modify)
- Test: `tests/core/opencode.test.ts`

**Interfaces:**
- Produces: `writeOpenCodeFiles(root): { created: string[]; skipped: string[] }`
- Файлы: `.opencode/plugins/toolbox-al/index.ts`, `.opencode/skills/toolbox-al/SKILL.md`, `.opencode/skills/toolbox-al-setup/SKILL.md`, блок в `AGENTS.md` между `<!-- toolbox-al:begin -->` и `<!-- toolbox-al:end -->`

- [ ] **Step 1: Write the failing test**

```ts
test('файлы создаются и не перезаписываются', () => {
  const root = mkdtempSync(join(tmpdir(), 'oc-'))
  const first = writeOpenCodeFiles(root)
  assert.ok(first.created.length >= 3)
  const second = writeOpenCodeFiles(root)
  assert.deepEqual(second.created, [])
  const agents = readFileSync(join(root, 'AGENTS.md'), 'utf8')
  assert.equal(agents.match(/toolbox-al:begin/g)!.length, 1)
})
```

- [ ] **Step 2: Run** → FAIL

- [ ] **Step 3: Implement** запись файлов и маркерный блок.

- [ ] **Step 4: Run** → PASS

- [ ] **Step 5: Commit** `feat: generate opencode plugin and skills`

---

### Task 2: Плагин с инструментами

**Files:**
- Create: `src/core/opencode-files/plugin.ts` (шаблон), modify `src/core/opencode.ts`
- Test: `tests/core/plugin.test.ts`

**Interfaces:**
- Плагин регистрирует: `al_now`, `al_inbox`, `al_task`, `al_take`, `al_done`, `al_block`, `al_ask`, `al_answer`
- Каждый вызывает `node <root>/bin/toolbox-al.ts <команда> --json`
- Ошибка CLI → `{ content: stderr }` с `isError: true`

- [ ] **Step 1: Write the failing test**

```ts
test('плагин содержит объявления инструментов и вызов CLI', () => {
  const source = pluginSource()
  for (const name of ['al_now', 'al_inbox', 'al_task', 'al_take', 'al_done', 'al_block']) {
    assert.ok(source.includes(name), name)
  }
  assert.match(source, /toolbox-al\.ts/)
  assert.match(source, /Plugin\.define/)
})
```

- [ ] **Step 2: Run** → FAIL

- [ ] **Step 3: Implement** шаблон плагина как строку; `writeOpenCodeFiles` кладёт его в файл.

- [ ] **Step 4: Run** → PASS

- [ ] **Step 5: Commit** `feat: opencode plugin with native tools`

---

### Task 3: Скилл и регламент

**Files:**
- Modify: `src/core/opencode.ts`
- Test: `tests/core/skill.test.ts`

**Interfaces:**
- Скилл `toolbox-al`: порядок работы (take → работа → done), правила (не коммитить, не менять чужую руку), карта команд.
- Скилл `toolbox-al-setup`: что прочитать в проекте, что предложить владельцу, что вызвать (`bootstrap`).
- `AGENTS.md`: короткий блок «порядок решает приложение».

- [ ] **Step 1: Write the failing test**

```ts
test('скилл описывает порядок работы и запрет на git', () => {
  const skill = skillSource()
  assert.match(skill, /al_task|task show/)
  assert.match(skill, /не коммит/i)
  assert.match(skill, /dispatch/)
})
```

- [ ] **Step 2–5:** стандартный цикл; коммит `feat: agent skills for toolbox-al`

---

### Task 4: `doctor` и версия плагина

**Files:**
- Modify: `src/core/doctor.ts`, `src/cli/commands/doctor.ts`
- Test: `tests/core/doctor-open`code.test.ts`

**Interfaces:**
- Проверки: `plugins/toolbox-al/index.ts` существует; скилл существует; версия плагина совпадает с `toolVersion` из конфига (маркер `// toolbox-al-plugin-version: X`).

- [ ] **Step 1: Write the failing test**

```ts
test('doctor замечает отсутствие плагина', () => {
  const report = doctorReport(db, { root: mkdtempSync(join(tmpdir(), 'oc-')) })
  assert.ok(report.checks.some((c) => c.name === 'плагин OpenCode' && !c.ok))
})
```

- [ ] **Step 2–5:** стандартный цикл; коммит `feat: doctor checks opencode files`

---

### Task 5: README и пример сессии

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Добавить раздел «OpenCode»**: что генерируется, как позвать оркестратора, какие инструменты доступны.
- [ ] **Step 2: Commit** `docs: opencode integration`

---

## Что этот план сознательно не делает

- Не регистрирует агентов через конфиг: формат агентов OpenCode меняется, поэтому агенты настраиваются пользователем, а поведение задаёт скилл.
- Не тестирует загрузку плагина в живом OpenCode: проверяется содержимое файлов и отсутствие логики в обёртке.

## Проверка готовности плана 5

- [ ] `init` создаёт плагин, скиллы и блок в `AGENTS.md`
- [ ] Повторный `init` ничего не перезаписывает и не дублирует
- [ ] Плагин объявляет инструменты и вызывает CLI
- [ ] Скилл объясняет порядок работы и запрет на git
- [ ] `doctor` замечает отсутствие плагина
