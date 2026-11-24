import { existsSync, mkdirSync, readFileSync, rmdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  effectiveReviewerModel,
  modelContext,
  type ModelContext,
} from './review-policy.ts'
import type { BoardSettings } from './settings.ts'

/**
 * Файлы OpenCode, которые `board init` кладёт в проект: тонкий плагин, четыре
 * навыка и команды ревью, плюс блок в `AGENTS.md`. Логики здесь нет: плагин
 * зовёт CLI, навыки объясняют порядок, команда ревью порождает субагента.
 * Шаблоны живут здесь строками, чтобы пакет `files` («bin», «src») содержал всё
 * необходимое.
 */

export const AGENTS_BEGIN = '<!-- board:begin -->'
export const AGENTS_END = '<!-- board:end -->'

export const AGENTS_BLOCK = [
  AGENTS_BEGIN,
  '## board',
  '',
  'Доска карточек: локальный `tools/board/bin/board.ts`; `BOARD_CLI` — только отладочный override.',
  '',
  '- Разговор ведёт brainstorming; spec и критерии приёмки пишутся в карточку, не в `docs/superpowers`.',
  '- Читай `docs/board/terminology.md` в начале сессии и перед разбором; команды владельца авторитетны.',
  '- Карточка: запрос → `card shape` (spec + критерии приёмки) → `card spec-review` → `card submit` → владелец `card approve`.',
  '- Префикс — область проекта (Сайт, Контент, CORE), не ярлык задачи: сначала `board group list`, новый — только с `--new-group`; в пустом проекте — CARD.',
  '- После approve plan пишет исполнитель при `take`; plan — это steps + scope + проверки.',
  '- Работа: `run start` → `take` (plan) → `finish --summary` → `run next` → `run end`; одиночный `take` без забега тоже работает.',
  '- Исполнение Native: агент делает сам, без субагентов-исполнителей; план — steps карточки.',
  '- `ask` — асинхронный вопрос; `block` — только если без ответа нельзя продолжать.',
  '- Spec review — `/spec-review` (self или субагент), run review — `/review` (plan + код).',
  '- Ревью идёт пакетом: ревьюер только читает, итоги прохода — `run note`. Первый проход полный; повторный — только дельта: исправлены ли находки и нет ли регрессий, новых он не ищет. Critical и регрессии чинятся сразу; important — finding-карточка в очередь; other — сборник в `deferred`.',
  '- Ревьюеры-субагенты работают на default-варианте `reviewer.model`; режимы задаёт `/setup`.',
  '- После `board init`, если в ответе `setupRequired: true`, спроси владельца и запусти `/setup`.',
  '- Коммит делаешь сам в ветке карточки; мерж в `dev` делает `finish`. `main` меняется только `release` владельцем.',
  AGENTS_END,
].join('\n')

export const SKILL_SPEC_SOURCE = `---
name: board-spec
description: Доска: разобрать запрос в spec и утвердить — критерии приёмки, вопросы, reviewRequired
---

# board-spec

Доска карточек: источник истины — \`.board/board.db\`; термины и команды владельца — \`docs/board/terminology.md\`. Они авторитетны: если фразы нет в списке — спроси владельца и предложи её добавить.

## Разговор и брейншторм

Разговор ведёт brainstorming, а не этот навык. В board-проекте brainstorming не пишет \`docs/superpowers/**\`: spec и критерии приёмки идут в карточку (\`card shape\`), решения — в body карточки или \`board decision\`, утверждение дизайна — \`card approve\`. Второго гейта (отдельного design doc) нет.

Доска реагирует только на глагол работы: «разбери / добавь / оформи» — карточка и навык board-spec, «работай» — board-work, «Ран» — board-run. Без глагола работы карточки не создаются: на «порассуждать» доска молчит.

## Тип карточки

Заголовок начинается с типа: \`feat:\` — новая возможность, \`fix:\` — дефект, \`perf:\` — производительность или размер, \`sec:\` — безопасность и права, \`docs:\` — документация, \`test:\` — тесты и покрытие, \`chore:\` — CI и инфраструктура, \`review:\` — работа после ревью. Теги вариантов (\`new\`/\`improve\`/\`review\`) остаются для очереди: префикс про суть, тег про порядок.

## Префикс

Префикс — это **область проекта** (Сайт, Контент, Мобильное, CORE), а не ярлык задачи; набор у каждого проекта свой.

1. Сначала \`board group list\` — посмотри, какие области уже есть, и выбери подходящую.
2. Новый префикс — только \`card add --group <P> --new-group\`, и только если ни одна существующая область не подходит; решение попадёт в журнал.
3. Если областей ещё нет, \`card add\` без \`--group\` берёт \`CARD\`.

## Разбор

1. Запрос → разбор: \`board card shape <ID> --as <исполнитель> [--from card.json]\`.
2. Вопросы по разбору решай в чате. \`ask\` — асинхронный вопрос, если владельца нет; \`block\` — только если без ответа нельзя продолжать. Угадывать нельзя.
3. Заполни **spec** (\`body\`): problem/why, результат, non-goals, ограничения, зависимости, риски и **критерии приёмки**. План (\`steps\`) при shape не пишется.
4. Spec review: \`/spec-review\`. Режим — \`board card show <ID> --json\` → \`specReview.mode\`: \`none\` — не нужна, \`self\` — сам, \`subagent\` — \`board-reviewer\`. Результат: \`board card spec-review <ID> --mode self|subagent --verdict done|reopen --note "..."\`.
5. \`board card submit <ID> --as <исполнитель>\`; владелец делает \`card approve\` или \`card reject\`.
6. После approve spec/acceptance/scope не меняются. Нужно изменение — \`board card amend <ID> --reason "..."\`, затем review и approve снова.

## Просто или не просто

- **Просто**: нового поведения нет, одна область, критерий проверяется глазами → \`reviewRequired=false\`, отдельный забег не нужен.
- **Не просто**: новое поведение или решение → \`reviewRequired=true\`, карточка идёт в забег.
- Уточнение владельца «тут перекрась» относится к текущей карточке: шаг в плане или \`card amend\`. Отдельная мелкая карточка добавляется в текущий забег владельцем или берётся без забега.

## Решения и термины

- \`board decision add [<ID>] "..." --kind decision|assumption --as <исполнитель>\`.
- \`board term add "термин" "значение" --as <исполнитель>\`.
- Команды владельца (\`board command list\`) читай, не редактируй: их пишет только owner.
`

export const SKILL_WORK_SOURCE = `---
name: board-work
description: Доска: исполнить карточку — take, план в steps, TDD, finish, отчёт
---

# board-work

## Исполнение

Всегда Native: агент исполняет карточку сам. Субагенты не используются для реализации, builder-check и написания spec/plan. TDD и проверки — по шагам; план живёт в steps карточки, отдельного plan-файла нет.

## Работа

1. \`board take <ID> --as <исполнитель>\` — карточка в работе. Для запроса первый \`take\` переводит его в разбор, второй — в работу.
2. Перед кодом напиши **plan**: \`board card step add <ID> "шаг + проверка"\`; scope зафиксирован в spec.
3. Долгая операция (полный прогон тестов, ревью, большой рефакторинг) — \`board touch <ID> --as <исполнитель>\`: lease 2 часа продлевается, иначе \`now\` или \`doctor\` снимут карточку. \`step add\` тоже продлевает lease.
4. Если plan требует новых файлов — \`board card scope add <ID> <path> --as <исполнитель>\`; если нового поведения или acceptance — \`amend\` или вопрос владельцу.
5. \`board finish <ID> --as <исполнитель> --summary "..."\` — сдать (review или done).
6. \`board run next --as <исполнитель>\` — следующая карточка забега.

## Проверки

- На карточке — целевые тесты затронутых файлов и проверка типов проекта; полный прогон после каждой карточки не нужен.
- Полный прогон — один раз, при сдаче bump-карточки перед релизом: её acceptance требует зелёный suite, там же фиксируется результат.
- Вне очереди полный прогон, если diff трогает общий каркас: настройки, жизненный цикл, git-слой, очередь, шаги.
- Bump-карточка перед релизом обновляет и \`package-lock.json\`: версия в lockfile совпадает с \`package.json\`.

## Отчёт

Одно сообщение на событие, не на команду; spec не пересказывать, сроки не обещать, о каждом вызове инструмента не отчитываться.

- разбор закончен — «Разобрал {ID}: …» и «Вопросов нет» либо список вопросов;
- второй \`take\` — «Приступаю к {ID}: шаги 1..N»;
- \`finish\` — две строки: «Сделал {ID}: что сделано.» и на следующей строке «Перехожу к {ID}: что сделаю.»; для последней карточки забега — только «Сделал»;
- первая карточка забега — без «Сделал» до её завершения: её объявляют «Беру в работу» и «Приступаю»;
- зелёные тесты, doctor, typecheck и номера коммитов в чат не пиши: это шум. Сообщай, только если что-то упало, красное или мешает работе;
- \`block\` или \`drop\` — «Снял {ID}: причина, создал {ID}.»

## Ревью

- \`/spec-review\` — полнота spec до approve; self или субагент по настройке.
- \`/review\` — проход по пакету (\`board review list --json\`): все карточки в \`review\` с прошлого прохода. Субагент \`board-reviewer\` только читает: карточек не создаёт, итоги прохода пишет в \`run note\`.
- Первый проход полный. Повторный — только дельта: исправлены ли перечисленные находки и нет ли регрессий от фикса; новых находок он не ищет, полный \`node --test\` не перезапускает — верит прогону исполнителя и гоняет целевые тесты.
- critical и регрессии этого diff — чинятся сразу, карточка reopen.
- important — finding-карточка \`board review finding <ID> --severity important --text "..."\` встаёт в очередь; release не блокирует, берётся следующим раном по приоритету.
- other — один сборник \`review notes\` в \`deferred\`.
- Свою карточку не ревьюй: вердикт даёт свежий субагент. \`critical\` блокирует release.

## Правила

- Работай в ветке карточки: коммит делаешь сам, мерж в \`dev\` делает \`board finish\`. В \`main\` не пиши — его меняет \`release\` владельца.
- Причина обязательна у block/cancel/reject/reopen; \`finish\` требует \`--summary\`.
- \`card reopen\` — только владелец; агент не обходит ею ревью и лимит переоткрытий.
`

export const SKILL_RUN_SOURCE = `---
name: board-run
description: Доска: забег — «Ран», состав, порядок карточек, run next/end
---

# board-run

## Забег

1. \`board run start --as <исполнитель> --cards <ID>,...\` (или \`--suggest 1|2|3\` — вариант new/improve/review). На старте не больше 3 карточек.
2. \`board run next --as <исполнитель>\` — следующая карточка забега.
3. \`board run end --as <исполнитель> [--review|--no-review]\` — закрыть забег; если \`reviewMode\` не \`none\`, запусти \`/review\`.
4. \`board run add <ID>\`, \`board run drop <ID>\` — состав забега.

## Ран

Владелец говорит «Ран» — выполни \`board run start\` (по \`--cards\` или \`--suggest\`) и сразу напиши блок «Беру в работу (n)»: по строке на карточку — ID, заголовок и 1–2 предложения, что будет сделано. Состав в ответе совпадает с фактическим забегом; если брать нечего — так и скажи, забег не открывай.

Перед долгой операцией — \`board touch <ID> --as <исполнитель>\`: \`now\` и \`doctor\` снимают карточку с просроченным lease, а \`touch\` и \`step add\` продлевают его на два часа.

## Рост забега

Размер забега ограничен только на старте. Дальше он растёт:

- владелец может добавить карточку в активный забег в любой момент — \`run add\`;
- агент сам добавляет только части только что разобранной карточки;
- части встают в хвост; когда они закрыты, родитель возвращается в хвост того же забега;
- отложить часть — значит отложить родителя: сказать это владельцу вслух.

## Отчёт

Одно сообщение на событие, не на команду; spec не пересказывать, сроки не обещать, о каждом вызове инструмента не отчитываться. События по самой карточке — в board-work.

- \`run start\` — «Беру в работу (n)» и по 1–2 предложения на карточку: что будет сделано;
- \`run end\` — «Завершил {RUN}.» и по строке на каждую карточку: «1. {ID} — что сделано», «2. …» и так далее;
- пустая строка, затем «Ревью ожидают задачи (n):» и по строке на каждый ID, если в \`review\` что-то есть; последняя строка блока — «Ревью сейчас или до релиза?»;
- пустая строка, затем «Следующий Run:» и заголовки карточек из очереди, по строке на карточку — только если очередь не пуста;
- последняя строка — «Запустить следующий Run?».

## Пакет и проход ревью

Пакет ревью — все карточки в \`review\` с прошлого прохода. Он не ограничен; проходов может быть несколько, вести их может один ревьюер подряд. Ревью запускается по слову владельца «Ревью», после накопления и обязательно перед release.

Бюджет прохода: critical и регрессии этого diff — всегда; important — finding-карточка в очередь; other — один сборник \`review notes: <пакет>\` в deferred. Больше 7 находок на проход не перечисляй. Повторный проход — только дельта: исправлены ли находки и нет ли регрессий, новых он не ищет и полный прогон тестов не перезапускает.

Ревьюер только читает: карточек не создаёт. Итоги прохода — \`board run note <RUN> --text "..." --as <ревьюер>\` (или \`board review submit <ID> --plan done --verdict done --reviewer <ревьюер> --note "ИТОГИ: ..."\` для одиночной карточки), в карточке — вердикт и ссылка \`board card ref add <ID> --kind review --value <RUN> --title "итоги прохода"\`. Оформляет находки агент: critical и important — через \`review finding\`, other — в сборник.
`

export const SKILL_NOW_SOURCE = `---
name: board-now
description: Доска: посмотреть состояние — now 0/1/2/3, очередь, забеги
---

# board-now

\`board now\` (инструмент \`board_now\`): \`now 0\` — владельцу (по умолчанию), \`now 1\` — текущий агент, \`now 2\` — другие агенты, \`now 3\` — запросы и очередь. Варианты забега задаются тегами карточки: \`new\`, \`improve\`, \`review\`.

Показывает статусы, держателей и вероятные забеги; ничего не меняет.
`

export const PLUGIN_SOURCE = `// Инструменты: board_now, board_setup, board_card, board_run, board_take,
// board_finish, board_block, board_ask, board_answer, board_review,
// board_decision, board_term.
import { Plugin } from '@opencode/plugin'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

// Внутри OpenCode process.execPath — сам opencode, а не node.
const nodeBin = /node(\\.exe)?$/i.test(process.execPath) ? process.execPath : 'node'

function projectRoot(ctx) {
  const canonical = ctx.location && ctx.location.project && ctx.location.project.canonical
  if (canonical) return canonical
  let dir = ctx.location.directory
  for (;;) {
    if (existsSync(join(dir, '.board'))) return dir
    if (existsSync(join(dir, '.git'))) {
      return basename(dirname(dir)) === '.worktrees' ? dirname(dirname(dir)) : dir
    }
    const parent = join(dir, '..')
    if (parent === dir) return dir
    dir = parent
  }
}

function resolveCli(ctx) {
  const root = projectRoot(ctx)
  const local = [
    join(root, 'tools', 'board', 'bin', 'board.ts'),
    join(root, 'bin', 'board.ts'),
  ].find((file) => existsSync(file))
  if (local) return { file: nodeBin, args: [local] }
  if (process.env.BOARD_CLI) return { file: nodeBin, args: [process.env.BOARD_CLI] }
  return { file: null, args: [], error: 'board не установлен: выполните board init' }
}

async function call(ctx, args, context) {
  const { file, args: prefix, error } = resolveCli(ctx)
  if (!file) return { content: error, isError: true }
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
  try {
    const { stdout } = await run(file, [...prefix, ...args, '--json'], {
      cwd: ctx.location.directory,
      timeout: 120_000,
      maxBuffer: 8 * 1024 * 1024,
      env,
      windowsHide: true,
    })
    return { content: stdout.trim() || '{}' }
  } catch (error) {
    if (error.code === 'ENOENT') {
      return { content: 'CLI board не найден: выполните board init', isError: true }
    }
    // Код 1 — «делать нечего», 2 — «нужно решение владельца»: это не ошибки.
    const status = typeof error.code === 'number' ? error.code : null
    return {
      content: error.stdout?.trim() || error.stderr?.trim() || error.message,
      isError: status === null ? true : status >= 3,
    }
  }
}

const schema = (properties, required = []) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
})

function flag(args, name, value) {
  if (value === undefined || value === null || value === '') return
  args.push('--' + name, String(value))
}

// Компактные ответы для агента: CLI печатает карточку целиком, плагин — нет.
function cardRow(card) {
  const row = { id: card.id, status: card.status }
  if (card.title) row.title = card.title
  if (card.skill) row.skill = card.skill
  if (card.group) row.group = card.group
  if (card.holder) row.holder = card.holder
  return row
}

function runRow(run) {
  const row = { id: run.id, status: run.status, executor: run.executorId }
  if (run.createdAt) row.createdAt = run.createdAt
  if (run.endedAt) row.endedAt = run.endedAt
  if (Array.isArray(run.notes)) row.notes = run.notes.length
  return row
}

function compactCard(value) {
  if (Array.isArray(value)) return value.map(compactCard)
  if (!value || typeof value !== 'object') return value
  if (typeof value.id !== 'string' || typeof value.status !== 'string') return value
  const out = { id: value.id, status: value.status }
  if (value.branch) out.branch = value.branch
  if (value.position !== null && value.position !== undefined) out.position = value.position
  return out
}

function compactNow(value) {
  return stripHeavy(value)
}

// Тяжёлые поля карточки встречаются в любом вложенном месте now: approvals,
// queue, requests, executors[].cards, probableRuns[].cards[].card.
function isCard(value) {
  return (
    !!value &&
    typeof value === 'object' &&
    typeof value.id === 'string' &&
    typeof value.status === 'string' &&
    'createdAt' in value
  )
}

function stripHeavy(value) {
  const heavy = ['body', 'acceptance', 'scope', 'steps']
  if (Array.isArray(value)) return value.map(stripHeavy)
  if (!value || typeof value !== 'object') return value
  if (isCard(value)) return cardRow(value)
  const out = {}
  for (const key of Object.keys(value)) {
    if (heavy.includes(key)) continue
    out[key] = stripHeavy(value[key])
  }
  return out
}

async function withJson(result, fn) {
  const resolved = await result
  if (!resolved || resolved.isError) return resolved
  try {
    return { ...resolved, content: JSON.stringify(fn(JSON.parse(resolved.content))) }
  } catch {
    return resolved
  }
}

function cardArgs(input) {
  const a = input.action
  if (a === 'step' || a === 'ref' || a === 'dep' || a === 'scope') {
    const args = ['card', a, input.sub]
    if (input.id) args.push(input.id)
    if (a === 'step' && input.sub === 'add') {
      if (input.text) args.push(input.text)
    } else if (a === 'step' || a === 'ref') {
      if (input.index !== undefined) args.push(String(input.index))
    }
    if (a === 'ref' && input.sub === 'add') {
      flag(args, 'kind', input.kind)
      flag(args, 'value', input.value)
      flag(args, 'title', input.title)
    }
    if (a === 'dep' && (input.sub === 'add' || input.sub === 'remove')) {
      const other = input.other ?? input.value
      if (other) args.push(String(other))
    }
    if (a === 'scope' && Array.isArray(input.paths)) {
      for (const path of input.paths) args.push(String(path))
    }
    flag(args, 'reason', input.reason)
    flag(args, 'as', input.as)
    return args
  }

  const args = ['card', input.action]
  if (a === 'add') {
    flag(args, 'group', input.group)
    flag(args, 'title', input.title)
    flag(args, 'spec', input.spec ?? input.body)
    if (Array.isArray(input.acceptance)) for (const item of input.acceptance) args.push('--acceptance', String(item))
    if (Array.isArray(input.tags)) for (const tag of input.tags) args.push('--tag', String(tag))
    if (input.importance !== undefined) args.push('--importance', String(input.importance))
    if (input.urgency !== undefined) args.push('--urgency', String(input.urgency))
    if (Array.isArray(input.scope)) for (const path of input.scope) args.push('--scope', String(path))
    if (input.needs_merge !== undefined) args.push(input.needs_merge ? '--needs-merge' : '--no-needs-merge')
    if (input.review !== undefined) args.push(input.review ? '--review' : '--no-review')
    if (input.new_group) args.push('--new-group')
    flag(args, 'note', input.note)
    flag(args, 'skill', input.skill)
    flag(args, 'as', input.as)
  } else if (a === 'list') {
    flag(args, 'phase', input.phase)
    flag(args, 'status', input.status)
    flag(args, 'skill', input.skill)
  } else if (a === 'show') {
    if (input.id) args.push(input.id)
  } else if (a === 'edit') {
    if (input.id) args.push(input.id)
    flag(args, 'title', input.title)
    flag(args, 'spec', input.spec ?? input.body)
    if (Array.isArray(input.acceptance)) for (const item of input.acceptance) args.push('--acceptance', String(item))
    flag(args, 'skill', input.skill)
    if (input.importance !== undefined) args.push('--importance', String(input.importance))
    if (input.urgency !== undefined) args.push('--urgency', String(input.urgency))
    if (input.needs_merge !== undefined) args.push(input.needs_merge ? '--needs-merge' : '--no-needs-merge')
    if (input.review !== undefined) args.push(input.review ? '--review' : '--no-review')
    if (Array.isArray(input.scope)) for (const s of input.scope) args.push('--scope', String(s))
    if (Array.isArray(input.tags)) for (const tag of input.tags) args.push('--tag', String(tag))
    if (input.clear_tags) args.push('--clear-tags')
    flag(args, 'note', input.note)
    flag(args, 'as', input.as)
  } else if (a === 'defer' || a === 'resume') {
    if (input.id) args.push(input.id)
    if (a === 'defer') flag(args, 'note', input.note)
    flag(args, 'as', input.as)
  } else if (a === 'shape' || a === 'submit') {
    if (input.id) args.push(input.id)
    flag(args, 'from', input.from)
    flag(args, 'as', input.as)
  } else if (a === 'spec-review') {
    if (input.id) args.push(input.id)
    flag(args, 'mode', input.mode)
    flag(args, 'verdict', input.verdict)
    flag(args, 'note', input.note)
    flag(args, 'as', input.as)
  } else if (a === 'amend') {
    if (input.id) args.push(input.id)
    flag(args, 'reason', input.reason)
    flag(args, 'as', input.as)
  } else if (a === 'approve' || a === 'done' || a === 'reopen') {
    if (input.id) args.push(input.id)
    if (a === 'done') flag(args, 'summary', input.summary)
    if (a === 'reopen') flag(args, 'reason', input.reason)
    flag(args, 'as', input.as)
  } else if (a === 'reject' || a === 'cancel') {
    if (input.id) args.push(input.id)
    flag(args, 'reason', input.reason)
    if (input.waive_dependents) args.push('--waive-dependents')
    flag(args, 'as', input.as)
  } else if (a === 'verdict') {
    if (input.id) args.push(input.id)
    flag(args, 'plan', input.plan)
    if (input.done) args.push('--done')
    if (input.reopen) args.push('--reopen')
    flag(args, 'mode', input.mode)
    flag(args, 'note', input.note)
    flag(args, 'as', input.as)
  }
  return args
}

function runArgs(input) {
  const args = ['run', input.action]
  const a = input.action
  if (a === 'start') {
    flag(args, 'cards', input.cards)
    if (input.suggest !== undefined) args.push('--suggest', String(input.suggest))
    if (input.review === true) args.push('--review')
    else if (input.review === false) args.push('--no-review')
    flag(args, 'as', input.as)
  } else if (a === 'add' || a === 'drop') {
    if (input.id) args.push(input.id)
    flag(args, 'as', input.as)
  } else if (a === 'next') {
    flag(args, 'as', input.as)
  } else if (a === 'note') {
    if (input.id) args.push(input.id)
    flag(args, 'text', input.text)
    flag(args, 'as', input.as)
  } else if (a === 'end') {
    flag(args, 'as', input.as)
    if (input.review === true) args.push('--review')
    else if (input.review === false) args.push('--no-review')
  } else if (a === 'release') {
    if (input.id) args.push(input.id)
    flag(args, 'reason', input.reason)
    flag(args, 'as', input.as)
  }
  return args
}

function queueArgs(input) {
  const args = ['queue', input.action]
  if (input.action === 'move') {
    if (input.id) args.push(input.id)
    flag(args, 'before', input.before)
    if (input.top) args.push('--top')
    if (input.bottom) args.push('--bottom')
  }
  return args
}

function backupArgs(input) {
  if (input.action === 'export') {
    const args = ['export']
    flag(args, 'format', input.format)
    flag(args, 'out', input.out)
    if (input.md) args.push('--md')
    return args
  }
  const args = ['backup']
  if (input.out) args.push(String(input.out))
  return args
}

function reviewArgs(input) {
  const args = ['review', input.action]
  const a = input.action
  if (a === 'submit') {
    if (input.id) args.push(input.id)
    flag(args, 'plan', input.plan)
    flag(args, 'verdict', input.verdict)
    flag(args, 'mode', input.mode)
    flag(args, 'note', input.note)
    flag(args, 'reviewer', input.reviewer)
    flag(args, 'findings', input.findings)
  } else if (a === 'finding') {
    if (input.id) args.push(input.id)
    flag(args, 'severity', input.severity)
    flag(args, 'text', input.text)
    flag(args, 'reviewer', input.reviewer)
  }
  return args
}

function decisionArgs(input) {
  const args = ['decision', input.action]
  const a = input.action
  if (a === 'add') {
    if (input.id) args.push(input.id)
    if (input.text) args.push(input.text)
    flag(args, 'kind', input.kind)
    flag(args, 'as', input.as)
  } else if (a === 'supersede') {
    if (input.id) args.push(input.id)
    flag(args, 'by', input.by)
    flag(args, 'reason', input.reason)
    flag(args, 'as', input.as)
  } else if (a === 'obsolete') {
    if (input.id) args.push(input.id)
    flag(args, 'reason', input.reason)
    flag(args, 'as', input.as)
  }
  return args
}

function termArgs(input) {
  const args = ['term', input.action]
  const a = input.action
  if (a === 'add') {
    if (input.term) args.push(input.term)
    if (input.definition) args.push(input.definition)
    flag(args, 'example', input.example)
    flag(args, 'as', input.as)
  } else if (a === 'show') {
    if (input.term) args.push(input.term)
  }
  return args
}

export default Plugin.define({
  id: 'board',
  async setup(ctx) {
    // Брейншторм — часть работы по доске; строка в системном промпте не зависит
    // от того, загрузился ли навык, и от содержимого AGENTS.md.
    await ctx.session.hook('context', (event) => {
      event.system.push({
        type: 'text',
        text: 'Перед любой работой по доске используй brainstorming; в этом проекте его spec пишется в карточку. Разговор без глагола работы карточек не создаёт.',
      })
      event.system.push({
        type: 'text',
        text: 'Отчёт по ходу работы обязателен: каждое событие — отдельным сообщением сразу после него, до следующего вызова инструмента; финальный ответ эти сообщения не заменяет. «Беру в работу (n)» — на старте забега. На take — «Приступаю к {ID}: шаги 1..N». После finish — «Сделал {ID}: …» и на следующей строке «Перехожу к {ID}: …»; для последней карточки забега — только «Сделал». Первая карточка забега — без «Сделал» до её завершения. Итог забега: «Завершил {RUN}.» и список карточек; затем блок «Ревью ожидают задачи (n):» со списком ID и вопросом «Ревью сейчас или до релиза?» — только если в review что-то есть; затем «Следующий Run:» — только если очередь не пуста; последняя строка — «Запустить следующий Run?». Зелёные тесты, doctor, typecheck и номера коммитов в чат не пиши — только если упало.',
      })
    })

    await ctx.tool.transform((editor) => {
      editor.namespace({ name: 'board', description: 'Доска карточек board' })

      editor.add({
        name: 'now',
        description: 'Доска: открытые карточки, забеги, что ждёт владельца',
        input: schema({ tab: { type: 'string' }, as: { type: 'string' }, mine: { type: 'boolean' } }),
        execute: (input, context) => {
          const args = []
          if (input.tab) args.push(input.tab)
          if (input.mine) args.push('--mine')
          flag(args, 'as', input.as)
          return withJson(call(ctx, ['now', ...args], context), compactNow)
        },
      })

      editor.add({
        name: 'setup',
        description: 'Настройки доски: show|reviewer-model|spec-review|max-spec|large-spec|run-review',
        input: schema({ action: { type: 'string' }, value: { type: 'string' } }),
        execute: (input, context) => {
          const action = input.action ?? 'show'
          if (action === 'show') return call(ctx, ['setup', '--show'], context)
          const value = input.value
          if (!value) return { content: 'для ' + action + ' нужен value', isError: true }
          if (['reviewer-model', 'spec-review', 'max-spec', 'large-spec', 'branch-main', 'branch-dev', 'sync', 'run-review'].includes(action)) {
            return call(ctx, ['setup', '--' + action, value], context)
          }
          if (action === 'review-after-run' || action === 'no-review-after-run') {
            return call(ctx, ['setup', '--' + action], context)
          }
          return { content: 'неизвестное действие setup: ' + action, isError: true }
        },
      })

      editor.add({
        name: 'card',
        description: 'Карточки: add|list|show|edit|shape|submit|spec-review|approve|amend|reject|done|cancel|reopen|verdict|step|ref|dep|scope|defer|resume',
        input: schema({
          action: { type: 'string' },
          sub: { type: 'string', description: 'Подкоманда для step/ref/dep/scope: add|done|remove|list' },
          id: { type: 'string' },
          group: { type: 'string' },
          other: { type: 'string', description: 'Вторая карточка для dep' },
          text: { type: 'string', description: 'Текст шага' },
          index: { type: 'number', description: 'Номер шага или ссылки' },
          kind: { type: 'string', description: 'Вид ссылки: link|doc|spec' },
          value: { type: 'string', description: 'Значение ссылки' },
          paths: { type: 'array', items: { type: 'string' }, description: 'Пути для scope add' },
          title: { type: 'string' },
          body: { type: 'string' },
          spec: { type: 'string' },
          acceptance: { type: 'array', items: { type: 'string' } },
          skill: { type: 'string' },
          summary: { type: 'string' },
          reason: { type: 'string' },
          note: { type: 'string' },
          from: { type: 'string' },
          as: { type: 'string' },
          importance: { type: 'number' },
          urgency: { type: 'number' },
          needs_merge: { type: 'boolean' },
          review: { type: 'boolean' },
          scope: { type: 'array', items: { type: 'string' } },
          tags: { type: 'array', items: { type: 'string' } },
          clear_tags: { type: 'boolean' },
          new_group: { type: 'boolean', description: 'Префикс — новая область проекта' },
          waive_dependents: { type: 'boolean' },
          done: { type: 'boolean' },
          reopen: { type: 'boolean' },
          mode: { type: 'string' },
          verdict: { type: 'string' },
          plan: { type: 'string' },
          phase: { type: 'string' },
          status: { type: 'string' },
        }, ['action']),
        execute: (input, context) => {
          if (input.action === 'approve' && input.as !== 'owner') {
            return { content: 'approve — только владелец: укажите as: owner', isError: true }
          }
          if (['step', 'ref', 'dep', 'scope'].includes(input.action) && !input.sub) {
            return { content: 'нужен sub: add|done|remove|list', isError: true }
          }
          // shape со spec/acceptance/scope: сначала разбор, затем edit — одним действием.
          if (
            input.action === 'shape' &&
            (input.spec || Array.isArray(input.acceptance) || Array.isArray(input.scope))
          ) {
            return (async () => {
              const shaped = await call(ctx, cardArgs(input), context)
              if (shaped.isError) return shaped
              const edit = ['card', 'edit']
              if (input.id) edit.push(input.id)
              flag(edit, 'spec', input.spec)
              if (Array.isArray(input.acceptance)) {
                for (const item of input.acceptance) edit.push('--acceptance', String(item))
              }
              if (Array.isArray(input.scope)) {
                for (const path of input.scope) edit.push('--scope', String(path))
              }
              flag(edit, 'as', input.as)
              return call(ctx, edit, context)
            })()
          }
          const result = call(ctx, cardArgs(input), context)
          if (input.action === 'show') return result
          if (input.action === 'list') {
            return withJson(result, (value) => (Array.isArray(value) ? value.map(cardRow) : value))
          }
          return withJson(result, compactCard)
        },
      })

      editor.add({
        name: 'run',
        description: 'Забег: start|add|drop|next|note|end|release|list',
        input: schema({
          action: { type: 'string' },
          id: { type: 'string' },
          cards: { type: 'string' },
          text: { type: 'string', description: 'Итоги прохода для run note' },
          suggest: { type: 'number' },
          reason: { type: 'string' },
          review: {
            type: 'boolean',
            description: 'Не указывайте, чтобы взять настройку доски; true/false перекрывают её для этого забега',
          },
          as: { type: 'string' },
        }, ['action']),
        execute: (input, context) => {
          const result = call(ctx, runArgs(input), context)
          if (input.action === 'list') {
            return withJson(result, (value) => (Array.isArray(value) ? value.map(runRow) : value))
          }
          return result
        },
      })

      editor.add({
        name: 'queue',
        description: 'Очередь: move|reorder',
        input: schema({
          action: { type: 'string' },
          id: { type: 'string' },
          before: { type: 'string' },
          top: { type: 'boolean' },
          bottom: { type: 'boolean' },
        }, ['action']),
        execute: (input, context) => call(ctx, queueArgs(input), context),
      })

      editor.add({
        name: 'touch',
        description: 'Продлить lease карточки в работе',
        input: schema({ id: { type: 'string' }, as: { type: 'string' } }, ['id', 'as']),
        execute: (input, context) =>
          call(ctx, ['touch', input.id, ...(input.as ? ['--as', input.as] : [])], context),
      })

      editor.add({
        name: 'doctor',
        description: 'Проверка целостности доски',
        input: schema({}),
        execute: (_input, context) => call(ctx, ['doctor'], context),
      })

      editor.add({
        name: 'backup',
        description: 'Бэкап базы доски или экспорт карточек: backup|export',
        input: schema({
          action: { type: 'string' },
          format: { type: 'string' },
          out: { type: 'string' },
          md: { type: 'boolean' },
        }),
        execute: (input, context) => call(ctx, backupArgs(input), context),
      })

      editor.add({
        name: 'release',
        description: 'Релиз: dev в main, только владелец',
        input: schema({ as: { type: 'string' } }),
        execute: (input, context) => {
          if (input.as !== 'owner') {
            return { content: 'release — только владелец: укажите as: owner', isError: true }
          }
          return call(ctx, ['release', '--as', 'owner'], context)
        },
      })

      editor.add({
        name: 'group',
        description: 'Области проекта: список префиксов',
        input: schema({ action: { type: 'string' } }),
        execute: (input, context) => call(ctx, ['group', input.action ?? 'list'], context),
      })

      editor.add({
        name: 'take',
        description: 'Взять карточку в работу',
        input: schema({ id: { type: 'string' }, as: { type: 'string' } }, ['id']),
        execute: (input, context) =>
          call(ctx, ['take', input.id, ...(input.as ? ['--as', input.as] : [])], context),
      })

      editor.add({
        name: 'finish',
        description: 'Сдать карточку с отчётом',
        input: schema({ id: { type: 'string' }, summary: { type: 'string' }, as: { type: 'string' } }, ['id', 'summary']),
        execute: (input, context) =>
          call(ctx, ['finish', input.id, '--summary', input.summary, ...(input.as ? ['--as', input.as] : [])], context),
      })

      editor.add({
        name: 'block',
        description: 'Заблокировать карточку с причиной',
        input: schema(
          { id: { type: 'string' }, reason: { type: 'string' }, note: { type: 'string' }, as: { type: 'string' } },
          ['id', 'reason'],
        ),
        execute: (input, context) =>
          call(ctx, [
            'block',
            input.id,
            '--reason',
            input.reason,
            ...(input.note ? ['--note', input.note] : []),
            ...(input.as ? ['--as', input.as] : []),
          ], context),
      })

      editor.add({
        name: 'ask',
        description: 'Задать вопрос владельцу по карточке',
        input: schema(
          { id: { type: 'string' }, text: { type: 'string' }, as: { type: 'string' }, block: { type: 'boolean' } },
          ['id', 'text'],
        ),
        execute: (input, context) =>
          call(ctx, [
            'ask',
            input.id,
            input.text,
            ...(input.block ? ['--block'] : []),
            ...(input.as ? ['--as', input.as] : []),
          ], context),
      })

      editor.add({
        name: 'answer',
        description: 'Ответить на вопрос по карточке',
        input: schema(
          { id: { type: 'string' }, text: { type: 'string' }, as: { type: 'string' }, question: { type: 'number' } },
          ['id', 'text'],
        ),
        execute: (input, context) =>
          call(ctx, [
            'answer',
            input.id,
            input.text,
            ...(input.question !== undefined ? ['--question', String(input.question)] : []),
            ...(input.as ? ['--as', input.as] : []),
          ], context),
      })

      editor.add({
        name: 'review',
        description: 'Ревью: list|submit|finding',
        input: schema({
          action: { type: 'string' },
          id: { type: 'string' },
          verdict: { type: 'string' },
          note: { type: 'string' },
          reviewer: { type: 'string' },
          severity: { type: 'string' },
          text: { type: 'string' },
          findings: { type: 'string' },
          plan: { type: 'string' },
          mode: { type: 'string' },
        }, ['action']),
        execute: (input, context) => call(ctx, reviewArgs(input), context),
      })

      editor.add({
        name: 'decision',
        description: 'Решения и допущения: add|list|supersede|obsolete',
        input: schema({
          action: { type: 'string' },
          id: { type: 'string' },
          text: { type: 'string' },
          kind: { type: 'string' },
          by: { type: 'string' },
          reason: { type: 'string' },
          as: { type: 'string' },
        }, ['action']),
        execute: (input, context) => call(ctx, decisionArgs(input), context),
      })

      editor.add({
        name: 'term',
        description: 'Терминология: add|list|show',
        input: schema({
          action: { type: 'string' },
          term: { type: 'string' },
          definition: { type: 'string' },
          example: { type: 'string' },
          as: { type: 'string' },
        }, ['action']),
        execute: (input, context) => call(ctx, termArgs(input), context),
      })
    })
  },
})
`

export const COMMAND_SOURCE = `---
description: Ревью пакета карточек: план, код, итоги прохода
subagent: false
---

Ты — ревьюер. Только читаешь: файлы не редактируй, карточки не создавай
(ни \`board review finding\`, ни \`board card add\`).

Пакет карточек на ревью (\`board review list --json\`):

!\`board review list --json\`

Порядок:

1. Пакет — все карточки в \`review\` с прошлого прохода. Запусти субагента
   \`board-reviewer\` и передай ему пакет; проходов может быть несколько.
2. Каждая карточка: spec и все критерии приёмки, шаги plan, scope, diff.
3. Итоги прохода — один блок: покрытые карточки, вердикты, находки с severity
   и рангом important (не больше 7 находок).
   - для забега: \`board run note <RUN> --text "..." --as <ревьюер>\`;
   - для одиночной карточки: \`board review submit <ID> --plan done --verdict done --reviewer <ревьюер> --note "ИТОГИ: ..."\`.
4. Вердикт по каждой: \`board review submit <ID> --plan done|failed --verdict done|reopen --reviewer <ревьюер> --note "итоги: <RUN или ID>"\`.
   Critical или регрессия этого diff — \`reopen\`; \`plan failed\` требует \`reopen\`.
5. В карточке — ссылка: \`board card ref add <ID> --kind review --value <RUN> --title "итоги прохода"\`.
6. Бюджет прохода: critical и регрессии — всегда; important — finding-карточка
   в очередь; other — сборник в deferred. Повторный проход — только дельта:
   исправлены ли находки и нет ли регрессий; новых не ищет, полный прогон
   тестов не перезапускает.
7. Если карточек нет — сообщи, что ревьюить нечего.
`

export const SPEC_REVIEW_COMMAND_SOURCE = `---
description: Проверка полноты spec карточки
subagent: false
---

Проверь spec карточки $1. Не редактируй код.

1. Прочитай \`board card show $1 --json\` и возьми \`specReview.mode\`.
2. \`none\` — скажи, что проверка не требуется.
3. \`self\` — проверь сам: problem/why, результат, критерии приёмки, non-goals,
   ограничения, зависимости, риски и возможность написать plan.
4. \`subagent\` — запусти \`board-reviewer\` и передай ему spec и acceptance.
5. Если spec неполный, сначала дополни его из контекста проекта, затем задай
   вопрос владельцу (\`ask\`/\`block\`) и запиши \`--verdict reopen\`.
6. Запиши результат: \`board card spec-review $1 --as <ревьюер> --mode self|subagent --verdict done|reopen --note "..."\`.
7. При вердикте \`done\` отправь карточку на утверждение: \`board card submit $1 --as <исполнитель>\` — без этого владелец не сможет \`approve\`. При \`reopen\` submit не делай.
8. Владелец утверждает spec через \`board card approve $1\`.
`

export const SETUP_COMMAND_SOURCE = `---
description: Настройки доски
subagent: false
---

Покажи \`board setup --show --json\` и спроси владельца:

- spec review: auto/none/self/subagent;
- порог для max, символов (0 — выключить правило);
- большой spec для остальных уровней, символов (0 — выключить правило);
- run review: none/self/subagent/auto (проверяет plan и код);
- модель ревьюера: provider/model без #variant.

Затем выполни:

\`\`\`bash
board setup --spec-review <mode> --max-spec <n> --large-spec <n> --run-review <mode> --reviewer-model <provider/model>
\`\`\`

Если владелец не хочет менять настройку — ничего не выполняй.
`

export function reviewerAgentSource(model: string): string {
  const shellAllow = [
    'git diff*',
    'git log*',
    'git show*',
    'git rev-parse*',
    'git merge-base*',
    'board review list*',
    'board card show*',
    'board run list*',
    'board run note*',
    'board review submit*',
    'board card ref add*',
  ]
  const permissions = [
    '  - action: edit\n    resource: "*"\n    effect: deny',
    '  - action: read\n    resource: "*"\n    effect: allow',
    ...shellAllow.map((resource) => `  - action: shell\n    resource: "${resource}"\n    effect: allow`),
    '  - action: shell\n    resource: "*"\n    effect: deny',
  ].join('\n')

  return `---
description: Read-only reviewer for spec, plan and code
mode: subagent
model: ${model}
permissions:
${permissions}
---

Ты — свежий ревьюер. Не редактируй файлы и не создавай карточки:
ни \`board review finding\`, ни \`board card add\` — это отклоняется правами, а не просьбой.

Тесты не гоняй: их прогнал исполнитель, полный suite идёт перед релизом, CI — после push. Твой инструмент — чтение файлов и \`git diff\`.

Проверяй acceptance, plan и код. Итоги прохода пиши одним блоком:
- для забега — \`board run note <RUN> --text "..." --as <твой id>\`;
- для одиночной карточки — \`board review submit <ID> --plan done --verdict done --reviewer <твой id> --note "ИТОГИ: ..."\`.
В блоке: покрытые карточки, вердикты, находки с severity и рангом important.
Больше 7 находок на проход не перечисляй — выбирай важнейшие.

Вердикт по карточке: \`board review submit <ID> --plan done|failed --verdict done|reopen --reviewer <твой id> --note "итоги: <RUN или ID>"\`. Critical или регрессия из этого diff — \`reopen\`.
В карточке оставь ссылку: \`board card ref add <ID> --kind review --value <RUN> --title "итоги прохода"\`.
`
}

export interface OpenCodeWriteOptions {
  /** Перезаписать сгенерированные файлы, даже если они уже есть. */
  refresh?: boolean
  /** Настройки нужны для генерации board-reviewer.md. */
  settings?: BoardSettings
  /** Модель текущей сессии; по умолчанию читается из env плагина. */
  context?: ModelContext
}

export interface OpenCodeWriteResult {
  created: string[]
  updated: string[]
}

/** Пишет или удаляет board-reviewer.md по reviewer.model. */
export function writeReviewerAgent(
  root: string,
  settings: BoardSettings,
  refresh = false,
  context: ModelContext = modelContext(process.env),
): OpenCodeWriteResult {
  const relative = '.opencode/agents/board-reviewer.md'
  const path = join(root, relative)
  const model = effectiveReviewerModel(settings, context)

  if (!model) {
    if (!existsSync(path)) return { created: [], updated: [] }
    rmSync(path, { force: true })
    return { created: [], updated: [relative] }
  }

  const content = reviewerAgentSource(model)
  const exists = existsSync(path)
  if (exists && !refresh) return { created: [], updated: [] }
  if (exists && readFileSync(path, 'utf8') === content) return { created: [], updated: [] }

  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content, 'utf8')
  return exists ? { created: [], updated: [relative] } : { created: [relative], updated: [] }
}

/**
 * Пишет в `root` скилл, плагин, команды ревью/настроек и (при settings)
 * board-reviewer.md, и ставит блок `board:begin`/`board:end` в `AGENTS.md`.
 * По умолчанию существующие файлы не перезаписываются; `refresh` обновляет их
 * шаблонами (нужно после апгрейда CLI). Блок между маркерами заменяется на
 * канонический всегда.
 */
export function writeOpenCodeFiles(
  root: string,
  options: OpenCodeWriteOptions = {},
): OpenCodeWriteResult {
  const created: string[] = []
  const updated: string[] = []

  const files: Array<[string, string]> = [
    ['.opencode/skills/board-spec/SKILL.md', SKILL_SPEC_SOURCE],
    ['.opencode/skills/board-work/SKILL.md', SKILL_WORK_SOURCE],
    ['.opencode/skills/board-run/SKILL.md', SKILL_RUN_SOURCE],
    ['.opencode/skills/board-now/SKILL.md', SKILL_NOW_SOURCE],
    ['.opencode/plugins/board/index.ts', PLUGIN_SOURCE],
    ['.opencode/command/review.md', COMMAND_SOURCE],
    ['.opencode/command/spec-review.md', SPEC_REVIEW_COMMAND_SOURCE],
    ['.opencode/command/setup.md', SETUP_COMMAND_SOURCE],
  ]

  // Старый единый навык: удаляем только при refresh, иначе init не должен
  // трогать уже установленные файлы.
  const legacySkill = join(root, '.opencode', 'skills', 'board', 'SKILL.md')
  if (options.refresh && existsSync(legacySkill)) {
    rmSync(legacySkill)
    try {
      rmdirSync(dirname(legacySkill))
    } catch {
      // в каталоге остались чужие файлы — не трогаем
    }
  }
  for (const [relative, content] of files) {
    const path = join(root, relative)
    const exists = existsSync(path)
    if (exists && !options.refresh) continue
    if (exists && readFileSync(path, 'utf8') === content) continue

    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, content, 'utf8')
    ;(exists ? updated : created).push(relative)
  }

  if (options.settings) {
    const agent = writeReviewerAgent(
      root,
      options.settings,
      options.refresh === true,
      options.context ?? modelContext(process.env),
    )
    created.push(...agent.created)
    updated.push(...agent.updated)
  }

  const agentsPath = join(root, 'AGENTS.md')
  const current = existsSync(agentsPath) ? readFileSync(agentsPath, 'utf8') : ''
  const begin = current.indexOf(AGENTS_BEGIN)
  const end = current.indexOf(AGENTS_END)

  if (begin !== -1 && end !== -1 && end > begin) {
    const next = current.slice(0, begin) + AGENTS_BLOCK + current.slice(end + AGENTS_END.length)
    if (next !== current) {
      writeFileSync(agentsPath, next, 'utf8')
      updated.push('AGENTS.md (блок board)')
    }
  } else {
    const next = current.trimEnd()
      ? current.trimEnd() + '\n\n' + AGENTS_BLOCK + '\n'
      : AGENTS_BLOCK + '\n'
    mkdirSync(dirname(agentsPath), { recursive: true })
    writeFileSync(agentsPath, next, 'utf8')
    created.push('AGENTS.md (блок board)')
  }

  return { created, updated }
}
