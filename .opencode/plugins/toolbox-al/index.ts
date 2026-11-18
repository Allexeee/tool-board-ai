// toolbox-al-plugin-version: 1.0.2
import { Plugin } from '@opencode/plugin'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

// Внутри OpenCode process.execPath — это сам opencode, а не node.
const nodeBin = /node(\.exe)?$/i.test(process.execPath) ? process.execPath : 'node'

function resolve(ctx, args) {
  const override = process.env.TOOLBOX_AL_CLI
  const local = join(ctx.location.directory, 'bin', 'toolbox-al.ts')
  const pinned = join(ctx.location.directory, 'tools', 'toolbox-al', 'bin', 'toolbox-al.ts')

  if (override) return { file: nodeBin, args: [override, ...args] }
  if (existsSync(local)) return { file: nodeBin, args: [local, ...args] }
  if (existsSync(pinned)) return { file: nodeBin, args: [pinned, ...args] }
  return { file: 'toolbox-al', args }
}

async function call(ctx, args) {
  const { file, args: full } = resolve(ctx, [...args, '--json'])
  try {
    const { stdout } = await run(file, full, { cwd: ctx.location.directory, timeout: 120_000, maxBuffer: 8 * 1024 * 1024 })
    return { content: stdout.trim() || '{}' }
  } catch (error) {
    if (error.code === 'ENOENT') {
      return {
        content:
          'CLI toolbox-al не найден. Положите инструмент в bin/toolbox-al.ts или tools/toolbox-al/ и перезапустите OpenCode',
        isError: true,
      }
    }
    return { content: String(error.stderr ?? error.message).trim(), isError: true }
  }
}

const schema = (properties, required = []) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
})

/**
 * Исполнитель по умолчанию: первый живой из `now --json`.
 * Фиктивного имени нет: живых нет — ошибка называет заведённых исполнителей.
 */
async function pickExecutor(ctx) {
  const answer = await call(ctx, ['now'])
  if (answer.isError) return { error: `не удалось узнать исполнителей: ${answer.content}` }

  let view
  try {
    view = JSON.parse(answer.content)
  } catch {
    return { error: `не удалось разобрать now --json: ${String(answer.content).slice(0, 200)}` }
  }

  const holders = Array.isArray(view?.holders) ? view.holders : []
  const live = holders.find(
    (holder) => typeof holder?.executor === 'string' && holder.executor !== '' && holder?.state?.kind !== 'offline',
  )
  if (live) return { executor: live.executor }

  const names = holders
    .map((holder) => holder?.executor)
    .filter((name) => typeof name === 'string' && name !== '')
  const available = names.length > 0 ? names.join(', ') : 'никого'
  return {
    error: `executor не задан, а живых исполнителей нет. Доступные: ${available}. Укажите executor явно`,
  }
}

/** Явный executor побеждает; иначе берём первого живого. */
async function withExecutor(ctx, input, build) {
  const picked = input.executor ? { executor: input.executor } : await pickExecutor(ctx)
  if (!picked.executor) return { content: picked.error, isError: true }
  return build(picked.executor)
}


/** Версия CLI должна совпадать с плагином: иначе инструменты зовут чужие команды. */
async function checkVersion(ctx) {
  const answer = await call(ctx, ['version'])
  if (answer.isError) return
  try {
    const info = JSON.parse(answer.content)
    if (info?.tool && info.tool !== PLUGIN_VERSION) {
      console.error(
        `[toolbox-al] плагин ${PLUGIN_VERSION}, CLI ${info.tool}: обновите проект — toolbox-al upgrade --yes`,
      )
    }
  } catch {
    // старый CLI без --json: молчим, инструменты работают
  }
}

export default Plugin.define({
  id: 'toolbox-al',
  async setup(ctx) {
    await ctx.tool.transform((editor) => {
      editor.namespace({ name: 'al', description: 'Очередь задач и фич toolbox-al' })

      editor.add({
        name: 'now',
        description: 'Что происходит: фичи, этапы, кто что держит, сколько ждёт владельца',
        input: schema({}),
        execute: () => call(ctx, ['now']),
      })

      editor.add({
        name: 'inbox',
        description: 'Что ждёт человека: вопросы, ревью, приёмка этапов',
        input: schema({}),
        execute: () => call(ctx, ['inbox']),
      })

      editor.add({
        name: 'task',
        description: 'Контекст задачи: DoD, область, зависимости, ветка',
        input: schema({ id: { type: 'string' } }, ['id']),
        execute: (input) => call(ctx, ['task', 'show', input.id]),
      })

      editor.add({
        name: 'take',
        description: 'Взять задачу в работу; без id берёт следующую из руки',
        input: schema({ id: { type: 'string' }, executor: { type: 'string' } }),
        execute: (input) =>
          withExecutor(ctx, input, (executor) =>
            call(ctx, ['take', ...(input.id ? [input.id] : []), '--as', executor]),
          ),
      })

      editor.add({
        name: 'done',
        description: 'Закрыть задачу с отчётом; коммит делает приложение',
        input: schema(
          { id: { type: 'string' }, summary: { type: 'string' }, executor: { type: 'string' } },
          ['id', 'summary'],
        ),
        execute: (input) =>
          withExecutor(ctx, input, (executor) =>
            call(ctx, ['done', input.id, '--as', executor, '--summary', input.summary]),
          ),
      })

      editor.add({
        name: 'block',
        description: 'Прервать задачу с причиной из списка',
        input: schema(
          { id: { type: 'string' }, reason: { type: 'string' }, note: { type: 'string' }, executor: { type: 'string' } },
          ['id', 'reason', 'note'],
        ),
        execute: (input) =>
          withExecutor(ctx, input, (executor) =>
            call(ctx, [
              'block',
              input.id,
              '--as',
              executor,
              '--reason',
              input.reason,
              '--note',
              input.note,
            ]),
          ),
      })

      editor.add({
        name: 'ask',
        description: 'Задать вопрос владельцу по задаче или запросу',
        input: schema({ subject: { type: 'string' }, text: { type: 'string' }, to: { type: 'string' } }, [
          'subject',
          'text',
        ]),
        execute: (input) => call(ctx, ['ask', input.subject, input.text, '--to', input.to ?? 'owner']),
      })

      editor.add({
        name: 'dispatch',
        description: 'Кому какая задача достаётся и в каком дереве',
        input: schema({}),
        execute: () => call(ctx, ['dispatch']),
      })

      editor.add({
        name: 'review',
        description: 'Вердикт по задаче',
        input: schema(
          { id: { type: 'string' }, verdict: { type: 'string' }, note: { type: 'string' }, reviewer: { type: 'string' } },
          ['id', 'verdict'],
        ),
        execute: (input) =>
          call(ctx, [
            'review',
            input.id,
            '--as',
            input.reviewer ?? 'reviewer',
            '--verdict',
            input.verdict,
            ...(input.note ? ['--note', input.note] : []),
          ]),
      })

      editor.add({
        name: 'accept',
        description: 'Принять или вернуть этап',
        input: schema({ id: { type: 'string' }, reject: { type: 'string' } }, ['id']),
        execute: (input) =>
          input.reject
            ? call(ctx, ['stage', 'reject', input.id, '--reason', input.reject])
            : call(ctx, ['stage', 'accept', input.id]),
      })

      editor.add({
        name: 'answer',
        description: 'Ответить на вопрос',
        input: schema({ id: { type: 'string' }, text: { type: 'string' } }, ['id', 'text']),
        execute: (input) => call(ctx, ['answer', input.id, input.text]),
      })
    })
  },
})
