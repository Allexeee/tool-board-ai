import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { findProject } from '../../core/project.ts'
import { readConfig } from '../../core/config.ts'
import { boolFlag, type ParsedArgs } from '../args.ts'
import { ok } from '../output.ts'
import { UserError } from '../errors.ts'

const TASK = 'toolbox-al tick'

function taskExists(): boolean {
  if (process.platform !== 'win32') return false
  try {
    execFileSync('schtasks', ['/query', '/tn', TASK], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

export default async function command(args: ParsedArgs) {
  const project = findProject(process.cwd())
  if (!project) throw new UserError(3, 'проект не найден: выполните toolbox-al init')

  const config = readConfig(project.configPath)
  const action = args.sub ?? 'status'

  if (action === 'status') {
    ok(
      { enabled: config.scheduler, task: taskExists() },
      `конфиг: ${config.scheduler ? 'включён' : 'выключен'}, задача планировщика: ${taskExists() ? 'есть' : 'нет'}`,
    )
    return 0
  }

  if (action === 'enable') {
    if (!boolFlag(args, 'yes')) {
      ok(
        { enabled: config.scheduler },
        'ничего не изменено. Чтобы поставить задачу в планировщик Windows, повторите с --yes',
      )
      return 0
    }

    try {
      execFileSync('schtasks', ['/create', '/tn', TASK, '/tr', 'toolbox-al tick', '/sc', 'minute', '/f'])
    } catch (error) {
      throw new UserError(3, `планировщик не принял задачу: ${String((error as Error).message)}`)
    }

    writeFileSync(project.configPath, JSON.stringify({ ...config, scheduler: true }, null, 2) + '\n', 'utf8')
    ok({ enabled: true }, 'тикер включён, задача планировщика создана')
    return 0
  }

  if (action === 'disable') {
    if (taskExists()) {
      try {
        execFileSync('schtasks', ['/delete', '/tn', TASK, '/f'])
      } catch (error) {
        throw new UserError(3, `планировщик не удалил задачу: ${String((error as Error).message)}`)
      }
    }

    writeFileSync(project.configPath, JSON.stringify({ ...config, scheduler: false }, null, 2) + '\n', 'utf8')
    ok({ enabled: false }, 'тикер выключен')
    return 0
  }

  throw new UserError(3, 'использование: scheduler enable|disable|status [--yes]')
}
