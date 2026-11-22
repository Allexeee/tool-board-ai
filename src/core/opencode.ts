import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  effectiveReviewerModel,
  modelContext,
  type ModelContext,
} from './review-policy.ts'
import type { BoardSettings } from './settings.ts'

/**
 * Файлы OpenCode, которые `board init` кладёт в проект: тонкий плагин, скилл и
 * команду ревью, плюс блок в `AGENTS.md`. Логики здесь нет: плагин зовёт CLI,
 * скилл объясняет порядок, команда ревью порождает субагента. Шаблоны живут
 * здесь строками, чтобы пакет `files` («bin», «src») содержал всё необходимое.
 */

export const AGENTS_BEGIN = '<!-- board:begin -->'
export const AGENTS_END = '<!-- board:end -->'

export const AGENTS_BLOCK = [
  AGENTS_BEGIN,
  '## board',
  '',
  'Доска карточек: локальный `tools/board/bin/board.ts`; `BOARD_CLI` — только отладочный override.',
  '',
  '- Читай `docs/board/terminology.md` в начале сессии и перед разбором; команды владельца авторитетны.',
  '- Карточка: запрос → `card shape` (spec + критерии приёмки) → `card spec-review` → `card submit` → владелец `card approve`.',
  '- После approve plan пишет исполнитель при `take`; plan — это steps + scope + проверки.',
  '- Работа: `run start` → `take` (plan) → `finish --summary` → `run next` → `run end`.',
  '- Нужно решение владельца — `block`/`ask`; карточка ждёт.',
  '- Spec review — `/spec-review` (self или субагент), run review — `/review` (plan + код).',
  '- Ревью идёт одним циклом: findings становятся карточками; critical блокирует release, important/other — backlog.',
  '- Ревьюеры-субагенты работают на default-варианте `reviewer.model`; режимы задаёт `/setup`.',
  '- После `board init`, если в ответе `setupRequired: true`, спроси владельца и запусти `/setup`.',
  '- Коммит и мерж делает `finish`; агент в git не пишет. `main` меняется только `release` владельцем.',
  AGENTS_END,
].join('\n')

export const SKILL_SOURCE = `---
name: board
description: Доска карточек: смотреть now, разбирать spec, брать забег, закрывать, ревьюить
---

# board

Доска карточек для владельца и агентов. Источник истины — база \`.board/board.db\`; язык проекта — \`docs/board/terminology.md\`.

## Начало сессии

Прочитай \`docs/board/terminology.md\`: термины и команды владельца. Используй их в общении с владельцем. Команды владельца авторитетны: если фраза не описана — спроси и предложи добавить её владельцу.

## Смотреть доску

\`board now\` (инструмент \`board_now\`): \`now 0\` — владельцу (по умолчанию), \`now 1\` — текущий агент, очередь и вероятные забеги, \`now 2\` — другие агенты, \`now 3\` — запросы и очередь. Варианты забега задаются тегами карточки: \`new\`, \`improve\`, \`review\`.

## Карточка: spec и plan

1. Запрос → разбор: \`board card shape <ID> --as <исполнитель> [--from card.json]\`.
2. Если есть открытые вопросы — вытащи ответы у владельца (\`ask\`/\`block\`). Угадывать нельзя.
3. Заполни **spec** (\`body\`): problem/why, результат, non-goals, ограничения, зависимости, риски и **критерии приёмки** (\`--acceptance\` или \`acceptance\` в JSON). План (\`steps\`) при shape не пишется.
4. Spec review: \`/spec-review\`. Режим смотри в \`board card show <ID> --json\` → \`specReview.mode\`:
   - \`none\` — проверка не нужна;
   - \`self\` — проверь сам по чек-листу;
   - \`subagent\` — запусти \`board-reviewer\`.
5. Если spec неполный, сначала дополни его из контекста проекта, затем задай вопрос владельцу. Результат запиши: \`board card spec-review <ID> --as <ревьюер> --mode self|subagent --verdict done|reopen --note "..."\`.
6. \`board card submit <ID> --as <исполнитель>\`; владелец делает \`card approve\` или \`card reject\`.
7. После approve менять spec/acceptance/scope нельзя. Нужно изменение — \`board card amend <ID> --as <исполнитель> --reason "..."\`, затем снова review и approve.

## Забег и выполнение

1. \`board run start --as <исполнитель> --cards <ID>,...\` (или \`--suggest 1\` — вариант new).
2. \`board take <ID> --as <исполнитель>\` — карточка в работе. Если это запрос в забеге, первый \`take\` переводит его в разбор, второй после spec — в работу; approve владельца не требуется.
3. Перед кодом напиши **plan**: \`board card step add <ID> "шаг + проверка"\`; scope уже зафиксирован в spec при разборе.
4. Если plan требует нового поведения или scope — остановись, \`block\`/\`ask\` владельцу; после approve \`card edit\` не меняет scope, нужен \`card amend\`.
5. \`board finish <ID> --as <исполнитель> --summary "..."\` — сдать (review или done).
6. \`board run next --as <исполнитель>\` — следующая карточка.
7. \`board run end --as <исполнитель> [--review|--no-review]\` — закрыть забег. Если \`reviewMode\` не \`none\`, запусти \`/review\`.

## Если не можешь

- Решение владельца: \`board block <ID> --as <исполнитель> --reason needs_decision --note "..."\`.
- Вопрос: \`board ask <ID> "вопрос" --as <исполнитель> [--block]\`.

## Ревью

- \`/spec-review\` — полнота spec до approve. Может быть self или субагентом.
- \`/review\` — run review: соответствие plan и код; пакет — \`board review list --json\`. Субагент \`board-reviewer\` работает на default-варианте модели, не в Max.
- Findings: \`board review finding <ID> --severity critical|important|other --text "..."\`.
- Вердикт: \`board review submit <ID> --plan done|failed --verdict done|reopen --note "..." --reviewer <id>\`.
- \`plan failed\` требует \`reopen\`. \`done\` с findings разрешён: findings становятся карточками.
- Один цикл: findings не переоткрывают исходную карточку; \`critical\` блокирует release, \`important\`/\`other\` идут в backlog. Второй reopen — только владелец.
- Finding-карточки после approve могут собраться в отдельный fix run.

## Настройки

После установки плагина, если \`board setup --show --json\` вернул \`setupAt: null\`, спроси владельца и запусти \`/setup\`.

\`board setup --show --json\` — текущие настройки. Режимы:

- \`board setup --spec-review auto|none|self|subagent\`;
- \`board setup --large-spec 6000\`;
- \`board setup --run-review none|self|subagent|auto\`;
- \`board setup --reviewer-model provider/model\` (без \`#variant\`).

Если владелец не хочет менять настройку — ничего не выполняй.

## Решения и термины

- \`board decision add [<ID>] "..." --kind decision|assumption --as <исполнитель>\`.
- \`board term add "термин" "значение" --as <исполнитель>\`.
- Команды владельца (\`board command list\`) читай, не редактируй: их пишет только owner.

## Правила

- Работай в ветке карточки; коммит и мерж делает \`board finish\`. В \`main\` не пиши — его меняет \`release\` владельца.
- Причина обязательна у block/cancel/reject/reopen; \`finish\` требует \`--summary\`.
- Ревью своей карточки не давай: для кода вердикт — свежий субагент. Spec review может быть self по настройке.
- \`card reopen\` — только владелец; агент не обходит ею ревью и лимит переоткрытий.
- Один цикл ревью: не переоткрывай карточку из-за стилистических улучшений.
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
    })
    return { content: stdout.trim() || '{}' }
  } catch (error) {
    if (error.code === 'ENOENT') {
      return { content: 'CLI board не найден: выполните board init', isError: true }
    }
    return {
      content: error.stdout?.trim() || error.stderr?.trim() || error.message,
      isError: true,
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

function cardArgs(input) {
  const args = ['card', input.action]
  const a = input.action
  if (a === 'add') {
    flag(args, 'group', input.group)
    flag(args, 'title', input.title)
    flag(args, 'spec', input.spec ?? input.body)
    if (Array.isArray(input.acceptance)) for (const item of input.acceptance) args.push('--acceptance', String(item))
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
    flag(args, 'note', input.note)
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
    flag(args, 'as', input.as)
  } else if (a === 'add' || a === 'drop') {
    if (input.id) args.push(input.id)
    flag(args, 'as', input.as)
  } else if (a === 'next') {
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
          return call(ctx, ['now', ...args], context)
        },
      })

      editor.add({
        name: 'setup',
        description: 'Настройки доски: show|reviewer-model|spec-review|large-spec|run-review',
        input: schema({ action: { type: 'string' }, value: { type: 'string' } }),
        execute: (input, context) => {
          const action = input.action ?? 'show'
          if (action === 'show') return call(ctx, ['setup', '--show'], context)
          const value = input.value
          if (!value) return { content: 'для ' + action + ' нужен value', isError: true }
          if (['reviewer-model', 'spec-review', 'large-spec', 'run-review'].includes(action)) {
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
        description: 'Карточки: add|list|show|edit|shape|submit|spec-review|approve|amend|reject|done|cancel|reopen|verdict',
        input: schema({
          action: { type: 'string' },
          id: { type: 'string' },
          group: { type: 'string' },
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
          waive_dependents: { type: 'boolean' },
          done: { type: 'boolean' },
          reopen: { type: 'boolean' },
          mode: { type: 'string' },
          verdict: { type: 'string' },
          plan: { type: 'string' },
          phase: { type: 'string' },
          status: { type: 'string' },
        }, ['action']),
        execute: (input, context) => call(ctx, cardArgs(input), context),
      })

      editor.add({
        name: 'run',
        description: 'Забег: start|add|drop|next|end|release|list',
        input: schema({
          action: { type: 'string' },
          id: { type: 'string' },
          cards: { type: 'string' },
          suggest: { type: 'number' },
          reason: { type: 'string' },
          review: {
            type: 'boolean',
            description: 'Не указывайте, чтобы взять настройку доски; true/false перекрывают её для этого забега',
          },
          as: { type: 'string' },
        }, ['action']),
        execute: (input, context) => call(ctx, runArgs(input), context),
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
description: Ревью забега: plan и код
subagent: false
---

Ты — ревьюер. Не редактируй файлы.

Пакет карточек на ревью (\`board review list --json\`):

!\`board review list --json\`

Порядок:

1. Если предыдущий \`run end\` вернул \`reviewMode: subagent\`, запусти субагента
   \`board-reviewer\` и передай ему этот пакет. Если \`self\` — проверь сам.
2. Если \`reviewReopens > 0\` — проверь только diff и открытые findings;
   не перепроверяй всю карточку. Иначе проверь:
   - spec и все критерии приёмки;
   - все шаги plan выполнены, scope не превышен;
   - код: корректность, тесты, обработка ошибок, безопасность.
3. Findings оформляй до вердикта: \`board review finding <ID> --severity critical|important|other --text "..."\`.
4. Вердикт: \`board review submit <ID> --plan done|failed --verdict done|reopen --note "..." --reviewer review\`.
   - \`plan failed\` требует \`reopen\`;
   - \`plan done\` с code-findings — \`done\`; findings станут карточками.
5. Один цикл: не переоткрывай карточку из-за стиля. \`critical\` блокирует
   release; \`important\`/\`other\` — backlog. Второй reopen — только владелец.
6. Если карточек нет — сообщи, что ревьюить нечего.
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
   вопрос владельцу (\`ask\`/\`block\`). Не делай submit.
6. Запиши результат: \`board card spec-review $1 --as <ревьюер> --mode self|subagent --verdict done|reopen --note "..."\`.
7. Владелец утверждает spec через \`board card approve $1\`.
`

export const SETUP_COMMAND_SOURCE = `---
description: Настройки доски
subagent: false
---

Покажи \`board setup --show --json\` и спроси владельца:

- spec review: auto/none/self/subagent;
- большой spec, символов (0 — выключить правило);
- run review: none/self/subagent/auto (проверяет plan и код);
- модель ревьюера: provider/model без #variant.

Затем выполни:

\`\`\`bash
board setup --spec-review <mode> --large-spec <n> --run-review <mode> --reviewer-model <provider/model>
\`\`\`

Если владелец не хочет менять настройку — ничего не выполняй.
`

export function reviewerAgentSource(model: string): string {
  return `---
description: Read-only reviewer for spec, plan and code
mode: subagent
model: ${model}
permissions:
  - action: edit
    resource: "*"
    effect: deny
  - action: read
    resource: "*"
    effect: allow
  - action: shell
    resource: "*"
    effect: allow
---

Ты — свежий ревьюер. Не редактируй файлы. Проверяй spec/acceptance, plan и
код. Findings — с file:line. Вердикт записывай через
\`board review submit --plan done|failed\`.
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
    ['.opencode/skills/board/SKILL.md', SKILL_SOURCE],
    ['.opencode/plugins/board/index.ts', PLUGIN_SOURCE],
    ['.opencode/command/review.md', COMMAND_SOURCE],
    ['.opencode/command/spec-review.md', SPEC_REVIEW_COMMAND_SOURCE],
    ['.opencode/command/setup.md', SETUP_COMMAND_SOURCE],
  ]
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
