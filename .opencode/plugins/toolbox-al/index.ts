// toolbox-al-plugin-version: 1.0.1
import { Plugin } from '@opencode/plugin'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

function resolve(ctx, args) {
  const override = process.env.TOOLBOX_AL_CLI
  const local = join(ctx.location.directory, 'bin', 'toolbox-al.ts')
  const pinned = join(ctx.location.directory, 'tools', 'toolbox-al', 'bin', 'toolbox-al.ts')

  if (override) return { file: process.execPath, args: [override, ...args] }
  if (existsSync(local)) return { file: process.execPath, args: [local, ...args] }
  if (existsSync(pinned)) return { file: process.execPath, args: [pinned, ...args] }
  return { file: 'toolbox-al', args }
}

async function call(ctx, args) {
  const { file, args: full } = resolve(ctx, [...args, '--json'])
  try {
    const { stdout } = await run(file, full, { cwd: ctx.location.directory })
    return { content: stdout.trim() || '{}' }
  } catch (error) {
    return { content: String(error.stderr ?? error.message).trim(), isError: true }
  }
}

const schema = (properties, required = []) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
})

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
          call(ctx, ['take', ...(input.id ? [input.id] : []), '--as', input.executor ?? 'worker']),
      })

      editor.add({
        name: 'done',
        description: 'Закрыть задачу с отчётом; коммит делает приложение',
        input: schema(
          { id: { type: 'string' }, summary: { type: 'string' }, executor: { type: 'string' } },
          ['id', 'summary'],
        ),
        execute: (input) =>
          call(ctx, ['done', input.id, '--as', input.executor ?? 'worker', '--summary', input.summary]),
      })

      editor.add({
        name: 'block',
        description: 'Прервать задачу с причиной из списка',
        input: schema(
          { id: { type: 'string' }, reason: { type: 'string' }, note: { type: 'string' }, executor: { type: 'string' } },
          ['id', 'reason', 'note'],
        ),
        execute: (input) =>
          call(ctx, [
            'block',
            input.id,
            '--as',
            input.executor ?? 'worker',
            '--reason',
            input.reason,
            '--note',
            input.note,
          ]),
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
