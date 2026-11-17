import { UserError } from './errors.ts'

let jsonMode = false

export function setJsonMode(value: boolean): void {
  jsonMode = value
}

export function isJsonMode(): boolean {
  return jsonMode
}

const ANSI = {
  green: '\u001b[32m',
  yellow: '\u001b[33m',
  cyan: '\u001b[36m',
  gray: '\u001b[90m',
} as const

export type ColorName = keyof typeof ANSI

// цвет — украшение, а не данные: null — решает терминал, false — запрещено навсегда.
let colorMode: boolean | null = null

export function setColorMode(value: boolean | null): void {
  colorMode = value
}

export interface ColorContext {
  isTTY?: boolean | undefined
  env?: Record<string, string | undefined>
  json?: boolean
}

// цвет положен только живому терминалу: в пайп, файл и --json он не протекает.
export function colorEnabled(context: ColorContext = {}): boolean {
  if (context.json ?? jsonMode) return false
  const env = context.env ?? process.env
  const noColor = env.NO_COLOR
  if (noColor !== undefined && noColor !== '') return false
  // явный запрет сильнее терминала, явное включение нужно только проверкам.
  if (colorMode !== null) return colorMode
  return Boolean(context.isTTY ?? process.stdout.isTTY)
}

export function paint(text: string, color: ColorName, context?: ColorContext): string {
  if (!colorEnabled(context)) return text
  return `${ANSI[color]}${text}\u001b[0m`
}

export function ok(data: unknown, human: string): void {
  if (jsonMode) {
    process.stdout.write(JSON.stringify(data) + '\n')
    return
  }
  process.stdout.write(human + '\n')
}

export function fail(code: 1 | 2 | 3, message: string): never {
  throw new UserError(code, message)
}
