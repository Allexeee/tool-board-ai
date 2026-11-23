import { UserError } from './errors.ts'

export const COMMANDS_WITH_SUB = new Set([
  'card',
  'executor',
  'queue',
  'run',
  'decision',
  'term',
  'command',
  'review',
])

// Флаги CLI из спецификации §12. Неизвестный флаг — ошибка ввода (код 3).
const KNOWN_FLAGS = new Set([
  'json', 'help', 'version', 'as', 'group', 'title', 'body', 'skill', 'skills',
  'phase', 'status', 'holder', 'importance', 'urgency', 'needs-merge', 'no-needs-merge',
  'review', 'no-review', 'scope', 'from', 'kind', 'value', 'reason', 'note',
  'spec', 'acceptance', 'mode', 'plan', 'tag', 'clear-tags',
  'summary', 'waive-dependents', 'done', 'reopen', 'severity', 'text', 'verdict',
  'findings', 'reviewer', 'run-size', 'worktree', 'suggest', 'cards', 'before',
  'top', 'bottom', 'mine', 'limit', 'all', 'by', 'force', 'fresh', 'no-merge',
  'merge-commit', 'block', 'question', 'example', 'yes', 'show', 'refresh',
  'review-after-run', 'no-review-after-run', 'reviewer-model', 'spec-review',
  'large-spec', 'run-review', 'board-version', 'board-source', 'allow-downgrade',
])

const BOOLEAN_FLAGS = new Set([
  'json', 'help', 'version', 'needs-merge', 'no-needs-merge', 'review', 'no-review',
  'waive-dependents', 'done', 'reopen', 'top', 'bottom', 'mine', 'all', 'block',
  'force', 'fresh', 'no-merge', 'yes', 'show', 'refresh', 'review-after-run',
  'no-review-after-run', 'allow-downgrade', 'clear-tags',
])

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
      const name = eq === -1 ? token.slice(2) : token.slice(2, eq)
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

  return { command, sub, flags, positionals }
}

export function stringFlag(args: ParsedArgs, name: string): string | undefined {
  const value = args.flags[name]
  if (Array.isArray(value)) return value[value.length - 1]
  if (typeof value === 'string') return value
  return undefined
}

export function stringsFlag(args: ParsedArgs, name: string): string[] {
  const value = args.flags[name]
  if (value === undefined) return []
  if (value === true) throw new UserError(3, `--${name} требует значения`)
  if (Array.isArray(value)) return value
  return [String(value)]
}

export function boolFlag(args: ParsedArgs, name: string): boolean {
  return args.flags[name] === true || args.flags[name] === 'true'
}

export function numberFlag(args: ParsedArgs, name: string): number | undefined {
  const raw = stringFlag(args, name)
  if (raw === undefined) return undefined

  const value = Number(raw)
  if (raw.trim() === '' || !Number.isInteger(value)) {
    throw new UserError(3, `--${name} должно быть целым числом`)
  }
  return value
}
