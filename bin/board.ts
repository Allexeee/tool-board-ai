#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseArgs, boolFlag } from '../src/cli/args.ts'
import { setJsonMode } from '../src/cli/output.ts'
import { UserError } from '../src/cli/errors.ts'

const VERSION = (JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as { version?: string }).version ?? '0.0.0'

const HELP = `board — доска карточек для людей и агентов

  init                    создать .board/board.db и docs/board/

  executor add|list|edit|remove
  card add|list|show|edit  карточки
  card shape|submit|approve|reject|verdict|done|cancel|reopen
  card step add|done|remove|list
  card ref add|remove|list
  card dep add|remove|list
  queue move|reorder
  run start|add|drop|next|end|release|list
  take / finish / block / touch
  ask / answer
  decision add|list|supersede|obsolete
  term add|list|show
  command add|list
  review list|finding|submit
  release / now / doctor

  --json                  машинный вывод
  --as <id>               кто действует (журнал и проверки)

  коды выхода: 0 — успех, 1 — делать нечего, 2 — нужно решение, 3 — ошибка ввода
`

async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv)
  if (boolFlag(args, 'json')) setJsonMode(true)

  if (boolFlag(args, 'help') || args.command === 'help') {
    process.stdout.write(HELP)
    return 0
  }

  if (boolFlag(args, 'version') || args.command === 'version') {
    process.stdout.write(VERSION + '\n')
    return 0
  }

  const module = await loadCommand(args.command)
  if (!module) throw new UserError(3, `неизвестная команда ${args.command}`)
  return (await module.default(args)) ?? 0
}

const COMMANDS_DIR = fileURLToPath(new URL('../src/cli/commands/', import.meta.url))

async function loadCommand(command: string) {
  if (!command) return null
  const file = join(COMMANDS_DIR, `${command}.ts`)
  if (!existsSync(file)) return null

  try {
    return await import(pathToFileURL(file).href)
  } catch (error) {
    if ((error as { code?: string }).code !== 'ERR_MODULE_NOT_FOUND') throw error
    throw new UserError(
      3,
      `команда ${command} не загрузилась: её модуль не найден — ${(error as Error).message}`,
    )
  }
}

try {
  const code = await main(process.argv.slice(2))
  process.exitCode = code
} catch (error) {
  if (error instanceof UserError) {
    process.stderr.write(error.message + '\n')
    process.exitCode = error.code
  } else {
    process.stderr.write(String((error as Error)?.stack ?? error) + '\n')
    process.exitCode = 3
  }
}
