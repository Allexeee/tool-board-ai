import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

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
  'Доска карточек: `board` (если CLI в PATH); в плагине OpenCode — `BOARD_CLI`.',
  '',
  '- Читай `docs/board/terminology.md` в начале сессии и перед разбором; команды владельца авторитетны.',
  '- Карточка: запрос → `card shape` → `card submit` → владелец `card approve`/`card reject`.',
  '- Работа: `run start` → `take` → `finish --summary` → `run next` → `run end`.',
  '- Нужно решение владельца — `block`/`ask`; карточка ждёт.',
  '- Ревью — свежий субагент командой `/review`; CLI субагентов не порождает.',
  '- Ревью после каждого забега — настройка `/setup` (по умолчанию выкл.); если `run end` вернул `review=true`, запусти `/review`.',
  '- После `board init`, если в ответе `setupRequired: true`, спроси владельца и запусти `/setup`.',
  '- Коммит и мерж делает `finish`; агент в git не пишет. `main` меняется только `release` владельцем.',
  AGENTS_END,
].join('\n')

export const SKILL_SOURCE = `---
name: board
description: Доска карточек: смотреть now, разбирать, брать забег, закрывать, ревьюить
---

# board

Доска карточек для владельца и агентов. Источник истины — база \`.board/board.db\`; язык проекта — \`docs/board/terminology.md\`.

## Начало сессии

Прочитай \`docs/board/terminology.md\`: термины и команды владельца. Используй их в общении с владельцем. Команды владельца авторитетны: если фраза не описана — спроси и предложи добавить её владельцу.

## Смотреть доску

\`board now\` (инструмент \`board_now\`): \`now 0\` — владельцу, \`now 3\` — открытые карточки, \`now 1\`/\`now 2\` — забеги.

## Жизненный цикл карточки

1. Запрос → разбор: \`board card shape <ID> --as <исполнитель> [--from card.json]\`. Заполни body, шаги, навык, importance/urgency, needs_merge, review_required, scope, зависимости.
2. На утверждение: \`board card submit <ID> --as <исполнитель>\`.
3. Владелец: \`board card approve <ID>\` или \`board card reject <ID> --reason "..."\`.

## Забег и выполнение

1. \`board run start --as <исполнитель> --cards <ID>,...\` (или \`--suggest 1\`).
2. \`board take <ID> --as <исполнитель>\` — карточка в работе.
3. Работаешь.
4. \`board finish <ID> --as <исполнитель> --summary "..."\` — сдать (review или done).
5. \`board run next --as <исполнитель>\` — следующая карточка.
6. \`board run end --as <исполнитель> [--review|--no-review]\` — закрыть забег.
   Если в ответе \`review=true\` (настройка включена), запусти \`/review\`.

## Если не можешь

- Решение владельца: \`board block <ID> --as <исполнитель> --reason needs_decision --note "..."\`.
- Вопрос: \`board ask <ID> "вопрос" --as <исполнитель> [--block]\`.

## Ревью

\`board review list --json\` — карточки на ревью. Свежий субагент проверяет и выносит вердикт:

\`board review submit <ID> --verdict done|reopen --note "..." --reviewer <id>\`.

Находки: \`board review finding <ID> --severity critical|important|other --text "..."\`.

## Настройки

После установки плагина, если \`board setup --show --json\` вернул
\`setupAt: null\`, спроси владельца и запусти \`/setup\`.

\`board setup --show --json\` — текущие настройки. Ревью после каждого забега:

- \`board setup --review-after-run\` — включить;
- \`board setup --no-review-after-run\` — выключить.

Если включено, после \`board run end\` с \`review=true\` запусти \`/review\`.
Если выключено, review-карточки ждут ручного ревью. По умолчанию выключено.

## Решения и термины

- \`board decision add [<ID>] "..." --kind decision|assumption --as <исполнитель>\`.
- \`board term add "термин" "значение" --as <исполнитель>\`.
- Команды владельца (\`board command list\`) читай, не редактируй: их пишет только owner.

## Правила

- Работай в ветке карточки; коммит и мерж делает \`board finish\`. В \`main\` не пиши — его меняет \`release\` владельца.
- Причина обязательна у block/cancel/reject/reopen; \`finish\` требует \`--summary\`.
- Ревью своей карточки не давай: вердикт — свежий субагент.
`

export const PLUGIN_SOURCE = `// Инструменты: board_now, board_setup, board_card, board_run, board_take,
// board_finish, board_block, board_ask, board_answer, board_review,
// board_decision, board_term.
import { Plugin } from '@opencode/plugin'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

// Внутри OpenCode process.execPath — сам opencode, а не node.
const nodeBin = /node(\\.exe)?$/i.test(process.execPath) ? process.execPath : 'node'

function resolveCli(ctx) {
  const override = process.env.BOARD_CLI
  const local = join(ctx.location.directory, 'bin', 'board.ts')
  if (override) return { file: nodeBin, args: [override] }
  if (existsSync(local)) return { file: nodeBin, args: [local] }
  return { file: 'board', args: [] }
}

async function call(ctx, args) {
  const { file, args: prefix } = resolveCli(ctx)
  try {
    const { stdout } = await run(file, [...prefix, ...args, '--json'], {
      cwd: ctx.location.directory,
      timeout: 120_000,
      maxBuffer: 8 * 1024 * 1024,
    })
    return { content: stdout.trim() || '{}' }
  } catch (error) {
    if (error.code === 'ENOENT') {
      return { content: 'CLI board не найден. Укажите BOARD_CLI или положите bin/board.ts', isError: true }
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
    flag(args, 'body', input.body)
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
    flag(args, 'body', input.body)
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
    if (input.done) args.push('--done')
    if (input.reopen) args.push('--reopen')
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
    flag(args, 'verdict', input.verdict)
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
        execute: (input) => {
          const args = []
          if (input.tab) args.push(input.tab)
          if (input.mine) args.push('--mine')
          flag(args, 'as', input.as)
          return call(ctx, ['now', ...args])
        },
      })

      editor.add({
        name: 'setup',
        description: 'Настройки доски: show|review-after-run|no-review-after-run',
        input: schema({ action: { type: 'string' } }),
        execute: (input) => {
          const action = input.action ?? 'show'
          if (action === 'show') return call(ctx, ['setup', '--show'])
          if (action === 'review-after-run') return call(ctx, ['setup', '--review-after-run'])
          if (action === 'no-review-after-run') return call(ctx, ['setup', '--no-review-after-run'])
          return { content: 'неизвестное действие setup: ' + action, isError: true }
        },
      })

      editor.add({
        name: 'card',
        description: 'Карточки: add|list|show|edit|shape|submit|approve|reject|done|cancel|reopen|verdict',
        input: schema({
          action: { type: 'string' },
          id: { type: 'string' },
          group: { type: 'string' },
          title: { type: 'string' },
          body: { type: 'string' },
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
          phase: { type: 'string' },
          status: { type: 'string' },
        }, ['action']),
        execute: (input) => call(ctx, cardArgs(input)),
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
        execute: (input) => call(ctx, runArgs(input)),
      })

      editor.add({
        name: 'take',
        description: 'Взять карточку в работу',
        input: schema({ id: { type: 'string' }, as: { type: 'string' } }, ['id']),
        execute: (input) => call(ctx, ['take', input.id, ...(input.as ? ['--as', input.as] : [])]),
      })

      editor.add({
        name: 'finish',
        description: 'Сдать карточку с отчётом',
        input: schema({ id: { type: 'string' }, summary: { type: 'string' }, as: { type: 'string' } }, ['id', 'summary']),
        execute: (input) =>
          call(ctx, ['finish', input.id, '--summary', input.summary, ...(input.as ? ['--as', input.as] : [])]),
      })

      editor.add({
        name: 'block',
        description: 'Заблокировать карточку с причиной',
        input: schema(
          { id: { type: 'string' }, reason: { type: 'string' }, note: { type: 'string' }, as: { type: 'string' } },
          ['id', 'reason'],
        ),
        execute: (input) =>
          call(ctx, [
            'block',
            input.id,
            '--reason',
            input.reason,
            ...(input.note ? ['--note', input.note] : []),
            ...(input.as ? ['--as', input.as] : []),
          ]),
      })

      editor.add({
        name: 'ask',
        description: 'Задать вопрос владельцу по карточке',
        input: schema(
          { id: { type: 'string' }, text: { type: 'string' }, as: { type: 'string' }, block: { type: 'boolean' } },
          ['id', 'text'],
        ),
        execute: (input) =>
          call(ctx, [
            'ask',
            input.id,
            input.text,
            ...(input.block ? ['--block'] : []),
            ...(input.as ? ['--as', input.as] : []),
          ]),
      })

      editor.add({
        name: 'answer',
        description: 'Ответить на вопрос по карточке',
        input: schema(
          { id: { type: 'string' }, text: { type: 'string' }, as: { type: 'string' }, question: { type: 'number' } },
          ['id', 'text'],
        ),
        execute: (input) =>
          call(ctx, [
            'answer',
            input.id,
            input.text,
            ...(input.question !== undefined ? ['--question', String(input.question)] : []),
            ...(input.as ? ['--as', input.as] : []),
          ]),
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
        }, ['action']),
        execute: (input) => call(ctx, reviewArgs(input)),
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
        execute: (input) => call(ctx, decisionArgs(input)),
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
        execute: (input) => call(ctx, termArgs(input)),
      })
    })
  },
})
`

export const COMMAND_SOURCE = `---
description: Ревью карточек свежим субагентом
subagent: true
---

Ты — свежий ревьюер. Проверь карточки ниже и вынеси вердикт по каждой.

Пакет карточек на ревью (\`board review list --json\`):

!\`board review list --json\`

Порядок:

1. По каждой карточке проверь шаги, body, scope и diff (команда diff указана в пакете).
2. Если карточек на ревью нет — сообщи, что ревьюить нечего.
3. Вердикт по каждой карточке:
   - принято: \`board review submit <ID> --verdict done --note "..." --reviewer review\`
   - на доработку: \`board review submit <ID> --verdict reopen --note "..." --reviewer review\`
4. Находки оформляй до вердикта: \`board review finding <ID> --severity critical|important|other --text "..."\`.
5. Критические находки блокируют \`main\`, пока не закрыты.
`

export const SETUP_COMMAND_SOURCE = `---
description: Настройки доски
subagent: false
---

Спроси владельца, включать ли ревью после каждого забега. Покажи текущие
настройки: \`board setup --show --json\`.

Затем выполни одно:

- \`board setup --review-after-run\` — включить;
- \`board setup --no-review-after-run\` — выключить.

Если владелец не хочет менять настройку — ничего не выполняй. Не меняй другие
настройки.
`

export interface OpenCodeWriteOptions {
  /** Перезаписать сгенерированные файлы, даже если они уже есть. */
  refresh?: boolean
}

export interface OpenCodeWriteResult {
  created: string[]
  updated: string[]
}

/**
 * Пишет в `root` скилл, плагин, команды ревью и настроек, и ставит блок
 * `board:begin`/`board:end` в `AGENTS.md`. По умолчанию существующие файлы не
 * перезаписываются; `refresh` обновляет их шаблонами (нужно после апгрейда
 * CLI). Блок между маркерами заменяется на канонический всегда.
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
