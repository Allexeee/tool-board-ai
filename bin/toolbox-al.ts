#!/usr/bin/env node
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseArgs, boolFlag } from '../src/cli/args.ts'
import { setJsonMode } from '../src/cli/output.ts'
import { UserError } from '../src/cli/errors.ts'

const HELP = `toolbox-al — ящик инструментов для работы по фичам

  init                    создать скелет проекта
  request add|list|open   запросы: добавить, все, незакрытые
  feature list|show|clean фичи: список, карточка, уборка каталога и ветки
  stage list|show|add|accept|merge этапы: список, карточка, добавление, приёмка, слияние в dev
  plan new|show|approve|apply планы: создать, показать, утвердить, применить
  task add|show|list|open задачи: добавить, карточка, список, открытые
  pool list|stale|merge   пул задач без фич
  executor add|list       исполнители
  hand show|set|add       руки исполнителей
  take / next             взять задачу
  touch                   продлить аренду
  done / block            закрыть, прервать
  reopen                  вернуть задачу в работу
  review <id> --verdict   вердикт по задаче на ревью
  ask / answer            вопросы
  now / inbox / cal       состояние, ожидание, календарь
  upgrade [--yes]         обновить инструмент в проекте
  release [уровень]       релиз: pending, major, minor или patch
  version                 версия инструмента
  dispatch                кому что достаётся
                          пример: toolbox-al dispatch --json
  doctor                  проверка настройки

  --json                  машинный вывод

  коды выхода: 0 — успех, 1 — делать нечего, 2 — нужно решение, 3 — ошибка ввода
`

async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv)
  if (boolFlag(args, 'json')) setJsonMode(true)

  if (boolFlag(args, 'help') || args.command === 'help') {
    process.stdout.write(HELP)
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
