import { readFileSync } from 'node:fs'
import { UserError } from './errors.ts'

const COMMANDS_WITH_SUB = new Set([
  'task', 'request', 'feature', 'stage', 'plan', 'executor', 'hand',
  'idea', 'decide', 'template', 'gate', 'scheduler', 'event', 'routine', 'plan', 'pool', 'release',
  'run', 'profiler',
])

const TEXT_FILE_COMMANDS = new Set(['idea', 'request'])

const KNOWN_FLAGS = new Set([
  'json', 'help', 'version', 'project', 'as', 'yes', 'dry-run', 'all',
  'title', 'body', 'author', 'text', 'text-file', 'name', 'goal', 'rank', 'to',
  'size', 'size-reason', 'dod', 'scope', 'skill', 'skills', 'class', 'kind',
  'check', 'deps', 'dep', 'review', 'verdict', 'choice', 'subject', 'reason', 'note', 'report', 'severity', 'version',
  'deadline', 'options', 'addressee', 'policy', 'timeout', 'appetite',
  'schedule', 'window', 'guard', 'action', 'cmd', 'on-missing', 'once', 'days', 'history', 'until', 'for', 'pin',
  'id', 'task', 'stage', 'feature', 'request', 'executor', 'session',
  'limit', 'from', 'main', 'dev', 'branch', 'force-outside', 'summary', 'checks', 'left', 'status',
  'write', 'brief', 'no-color', 'model', 'steps', 'allow', 'deny', 'clear',
  // прогон (RUN): режим, добор ближайших, утверждение начального плана, питание
  'mode', 'nearest', 'approve', 'power',
  // профайлер прогона: метка замера («2 агента»)
  'label',
])

const BOOLEAN_FLAGS = new Set(['json', 'help', 'version', 'yes', 'dry-run', 'once', 'all', 'branch', 'pin', 'force-outside', 'write', 'brief', 'no-color', 'clear', 'nearest', 'approve'])

export type FlagValue = string | boolean | string[]

export interface ParsedArgs {
  command: string
  sub: string | null
  flags: Record<string, FlagValue>
  positionals: string[]
}

export function parseArgs(argv: string[]): ParsedArgs {
  const flags: Record<string, FlagValue> = {}
  const positionals: string[] = []
  let command = ''
  let sub: string | null = null

  const setFlag = (name: string, value: string | boolean) => {
    const prev = flags[name]
    if (prev === undefined) {
      flags[name] = value
    } else if (Array.isArray(prev)) {
      prev.push(String(value))
    } else {
      flags[name] = [String(prev), String(value)]
    }
  }

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]

    if (token === '--') {
      positionals.push(...argv.slice(i + 1))
      break
    }

    if (token.startsWith('--')) {
      const eq = token.indexOf('=')
      const name = (eq === -1 ? token.slice(2) : token.slice(2, eq))
      if (!KNOWN_FLAGS.has(name)) {
        throw new UserError(3, `неизвестный флаг --${name}`)
      }
      if (eq !== -1) {
        setFlag(name, token.slice(eq + 1))
        continue
      }
      const next = argv[i + 1]
      if (next === undefined || next.startsWith('--') || BOOLEAN_FLAGS.has(name)) {
        setFlag(name, true)
      } else {
        setFlag(name, next)
        i++
      }
      continue
    }

    if (!command) {
      command = token
      continue
    }

    if (sub === null && COMMANDS_WITH_SUB.has(command) && positionals.length === 0) {
      sub = token
      continue
    }

    positionals.push(token)
  }

  if (!command) {
    if (flags.help) return { command: 'help', sub: null, flags, positionals }
    if (flags.version) return { command: 'version', sub: null, flags, positionals }
    throw new UserError(3, 'не указана команда')
  }

  if (flags['text-file'] !== undefined && !TEXT_FILE_COMMANDS.has(command)) {
    throw new UserError(3, `флаг --text-file не принимается командой ${command}`)
  }

  return { command, sub, flags, positionals }
}

export function stringFlag(args: ParsedArgs, name: string): string | undefined {
  const v = args.flags[name]
  if (Array.isArray(v)) return v[v.length - 1]
  if (typeof v === 'string') return v
  return undefined
}

/**
 * Текст из `--text-file`: путь к файлу в UTF-8 или `-` для stdin.
 * Пустой ввод — ошибка: пустая идея или тело запроса никому не нужны.
 * Если рядом задан текстовый флаг (`--text`/`--body`), он игнорируется, о чём и сообщаем.
 */
export function textFileFlag(
  args: ParsedArgs,
  name = 'text',
  options: { positional?: string | undefined } = {},
): string | undefined {
  const raw = args.flags['text-file']
  if (raw === undefined) return undefined
  if (raw === true) throw new UserError(3, 'использование: --text-file <файл|->')

  const path = stringFlag(args, 'text-file')!
  const source = path === '-' ? 'stdin' : `файла ${path}`

  let content: string
  try {
    content = readFileSync(path === '-' ? 0 : path, 'utf8')
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    const message =
      code === 'ENOENT' ? `файл ${path} не найден` : `не удалось прочитать файл ${path}: ${(error as Error).message}`
    throw new UserError(3, message)
  }

  const text = content.replace(/^\uFEFF/, '').replace(/[\r\n]+$/, '')
  if (text.trim() === '') {
    throw new UserError(3, path === '-' ? 'stdin пуст: текст не задан' : `файл ${path} пуст: текст не задан`)
  }

  if (stringFlag(args, name) !== undefined) {
    process.stderr.write(`текст взят из ${source}: --${name} проигнорирован\n`)
  }
  if (options.positional?.trim()) {
    process.stderr.write(`текст взят из ${source}: позиционный текст проигнорирован\n`)
  }
  return text
}

export function listFlag(args: ParsedArgs, name: string): string[] {
  const v = args.flags[name]
  if (v === undefined) return []
  if (Array.isArray(v)) return v
  return [String(v)]
}

export function boolFlag(args: ParsedArgs, name: string): boolean {
  return args.flags[name] === true || args.flags[name] === 'true'
}




