#!/usr/bin/env node
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

async function loadCommand(command: string) {
  try {
    return await import(`../src/cli/commands/${command}.ts`)
  } catch (error) {
    const code = (error as { code?: string }).code
    if (code === 'ERR_MODULE_NOT_FOUND') return null
    throw error
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
