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
  if (a === 'accept') {
    const args = ['card', 'accept']
    if (input.id) args.push(input.id)
    if (input.reject === true) args.push('--reject')
    flag(args, 'reason', input.reason)
    flag(args, 'note', input.note)
    flag(args, 'as', input.as)
    return args
  }
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
    if (input.owner_acceptance !== undefined) {
      args.push(input.owner_acceptance ? '--owner-acceptance' : '--no-owner-acceptance')
    }
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
    if (input.owner_acceptance !== undefined) {
      args.push(input.owner_acceptance ? '--owner-acceptance' : '--no-owner-acceptance')
    }
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
    if (a === 'submit' && input.no_decisions) args.push('--no-decisions')
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
    flag(args, 'acceptance', input.acceptance_result)
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

function ideaArgs(input) {
  const args = ['idea', input.action]
  const a = input.action
  if (a === 'add') {
    if (input.text) args.push(String(input.text))
    flag(args, 'title', input.title)
    flag(args, 'as', input.as)
  } else if (a === 'edit') {
    if (input.id) args.push(input.id)
    flag(args, 'text', input.text)
    flag(args, 'title', input.title)
    flag(args, 'as', input.as)
  } else if (a === 'drop') {
    if (input.id) args.push(input.id)
    flag(args, 'as', input.as)
  }
  return args
}

function acceptanceArgs(input) {
  const args = ['acceptance', input.action]
  if (input.action === 'check') {
    if (input.id) args.push(input.id)
    return args
  }
  if (input.action === 'rule') {
    if (input.sub) args.push(input.sub)
    if (input.name) args.push(input.name)
    for (const key of [
      'include_group',
      'include_tag',
      'include_skill',
      'include_path',
      'exclude_group',
      'exclude_tag',
      'exclude_skill',
      'exclude_path',
    ]) {
      const values = input[key]
      if (Array.isArray(values)) {
        for (const value of values) args.push(`--${key.replace('_', '-')}`, String(value))
      }
    }
  }
  return args
}

function tagArgs(input) {
  const args = ['tag', input.action]
  const a = input.action
  if (a === 'add') {
    if (input.name) args.push(String(input.name))
    flag(args, 'description', input.description)
  } else if (a === 'rename') {
    if (input.name) args.push(String(input.name))
    if (input.to) args.push(String(input.to))
  } else if (a === 'remove') {
    if (input.name) args.push(String(input.name))
  }
  flag(args, 'as', input.as)
  return args
}

function reviewArgs(input) {
  const args = ['review', input.action]
  const a = input.action
  if (a === 'submit') {
    if (input.id) args.push(input.id)
    flag(args, 'plan', input.plan)
    flag(args, 'acceptance', input.acceptance)
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
  } else if (a === 'waive') {
    if (input.id) args.push(input.id)
    flag(args, 'reason', input.reason)
    flag(args, 'as', input.as)
  } else if (a === 'package') {
    flag(args, 'since', input.since)
    flag(args, 'verdict', input.verdict)
    flag(args, 'note', input.note)
    flag(args, 'reviewer', input.reviewer)
    flag(args, 'findings', input.findings)
    flag(args, 'as', input.as)
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
        text: 'Отчёт по ходу работы обязателен: каждое событие — отдельным сообщением сразу после него, до следующего вызова инструмента; финальный ответ эти сообщения не заменяет. «Начинаю RUN-N» — на старте забега, затем по строке на карточку: «- {ID} — {заголовок}. Кратко, что будет сделано». На take — «Приступаю к {ID}: шаги 1..N». После finish — «Сделал {ID}: …»; для последней карточки забега — только «Сделал». Первая карточка забега — без «Сделал» до её завершения. Итог забега: «Завершил {RUN}.»; затем «Что сделано:» и короткий список человеческим языком — что нового и что изменилось, только важное для человека; затем «Решения, которые я принял сам:» и список решений агента (если решений нет — «Решений не принимал»); затем одно предложение действия: «Предлагаю дальше: …» и «Утверждаешь? Тогда …»; без утверждения владельца ничего не запускай (есть приёмка → ответить по задачам; иначе непустая очередь → следующий ран со списком ID). Ревью после run end автоматическое — отдельно его не предлагай. Зелёные тесты, doctor, typecheck и номера коммитов в чат не пиши — только если упало.',
      })
      event.system.push({
        type: 'text',
        text: 'После board upgrade или board init --refresh перескажи блок «Что нового» в чате человеческим языком: 3–5 пунктов, без флагов и CLI-жаргона. Если изменений нет — так и скажи. Затем одно действие: предложи board adopt --check, если проект ещё не приводили в порядок. adopt --check ничего не создаёт: покажи план, получи согласие и примени его обычными командами; повторный --check показывает остаток.',
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
        description: 'Настройки доски: show|defaults|reviewer-model|spec-review|max-spec|large-spec|run-review',
        input: schema({ action: { type: 'string' }, value: { type: 'string' } }),
        execute: (input, context) => {
          const action = input.action ?? 'show'
          if (action === 'show') return call(ctx, ['setup', '--show'], context)
          if (action === 'defaults') return call(ctx, ['setup', '--defaults'], context)
          const value = input.value
          if (!value) return { content: 'для ' + action + ' нужен value', isError: true }
          if (['reviewer-model', 'spec-review', 'max-spec', 'large-spec', 'branch-main', 'branch-dev', 'sync', 'backlog-path', 'backlog-refresh', 'run-review'].includes(action)) {
            return call(ctx, ['setup', '--' + action, value], context)
          }
          if (action === 'review-after-run' || action === 'no-review-after-run' || action === 'backlog-auto' || action === 'no-backlog-auto') {
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
          acceptance_result: { type: 'string', description: 'verdict: done|failed' },
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
          owner_acceptance: { type: 'boolean' },
          reject: { type: 'boolean' },
          no_decisions: { type: 'boolean', description: 'submit: решений владельца нет' },
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
        description: 'Ревью: list|package|submit|finding|waive',
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
          acceptance: { type: 'string' },
          reason: { type: 'string' },
          since: { type: 'string' },
          as: { type: 'string' },
          mode: { type: 'string' },
        }, ['action']),
        execute: (input, context) => call(ctx, reviewArgs(input), context),
      })

      editor.add({
        name: 'idea',
        description: 'Идеи: add|list|edit|drop',
        input: schema({
          action: { type: 'string' },
          id: { type: 'string' },
          text: { type: 'string' },
          title: { type: 'string' },
          as: { type: 'string' },
        }, ['action']),
        execute: (input, context) => call(ctx, ideaArgs(input), context),
      })

      editor.add({
        name: 'tag',
        description: 'Реестр тегов: add|list|rename|remove',
        input: schema({
          action: { type: 'string' },
          name: { type: 'string' },
          to: { type: 'string' },
          description: { type: 'string' },
          as: { type: 'string' },
        }, ['action']),
        execute: (input, context) => call(ctx, tagArgs(input), context),
      })

      editor.add({
        name: 'acceptance',
        description: 'Приёмка владельцем: rule|check',
        input: schema({
          action: { type: 'string' },
          sub: { type: 'string', description: 'rule: add|list|remove' },
          id: { type: 'string' },
          name: { type: 'string' },
          include_group: { type: 'array', items: { type: 'string' } },
          include_tag: { type: 'array', items: { type: 'string' } },
          include_skill: { type: 'array', items: { type: 'string' } },
          include_path: { type: 'array', items: { type: 'string' } },
          exclude_group: { type: 'array', items: { type: 'string' } },
          exclude_tag: { type: 'array', items: { type: 'string' } },
          exclude_skill: { type: 'array', items: { type: 'string' } },
          exclude_path: { type: 'array', items: { type: 'string' } },
        }, ['action']),
        execute: (input, context) => call(ctx, acceptanceArgs(input), context),
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
