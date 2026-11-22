// Инструменты: board_now, board_setup, board_card, board_run, board_take,
// board_finish, board_block, board_ask, board_answer, board_review,
// board_decision, board_term.
import { Plugin } from '@opencode/plugin'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

// Внутри OpenCode process.execPath — сам opencode, а не node.
const nodeBin = /node(\.exe)?$/i.test(process.execPath) ? process.execPath : 'node'

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
    // Брейншторм — часть работы по доске; строка в системном промпте не зависит
    // от того, загрузился ли навык, и от содержимого AGENTS.md.
    await ctx.session.hook('context', (event) => {
      event.system.push({
        type: 'text',
        text: 'Перед любой работой по доске используй brainstorming; в этом проекте его spec пишется в карточку. Разговор без глагола работы карточек не создаёт.',
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
