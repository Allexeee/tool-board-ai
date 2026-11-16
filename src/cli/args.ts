import { UserError } from './errors.ts'

const COMMANDS_WITH_SUB = new Set([
  'task', 'request', 'feature', 'stage', 'plan', 'executor', 'hand',
  'idea', 'decide', 'template', 'gate', 'scheduler', 'event', 'routine', 'plan',
])

const KNOWN_FLAGS = new Set([
  'json', 'help', 'version', 'project', 'as', 'yes', 'dry-run', 'all',
  'title', 'body', 'author', 'text', 'name', 'goal', 'rank', 'to',
  'size', 'size-reason', 'dod', 'scope', 'skill', 'skills', 'class', 'kind',
  'check', 'deps', 'dep', 'review', 'verdict', 'choice', 'subject', 'reason', 'note', 'report', 'severity', 'version',
  'deadline', 'options', 'addressee', 'policy', 'timeout', 'appetite',
  'id', 'task', 'stage', 'feature', 'request', 'executor',
  'limit', 'from', 'main', 'dev', 'summary', 'checks', 'left', 'status',
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
      const name = (eq === -1 ? token.slice(2) : token.slice(2, eq))
      if (!KNOWN_FLAGS.has(name)) {
        throw new UserError(3, `неизвестный флаг --${name}`)
      }
      if (eq !== -1) {
        setFlag(name, token.slice(eq + 1))
        continue
      }
      const next = argv[i + 1]
      if (next === undefined || next.startsWith('--')) {
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
  const v = args.flags[name]
  if (Array.isArray(v)) return v[v.length - 1]
  if (typeof v === 'string') return v
  return undefined
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
