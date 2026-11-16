import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { findProject } from '../../core/project.ts'
import { readConfig } from '../../core/config.ts'
import { boolFlag, type ParsedArgs } from '../args.ts'
import { ok } from '../output.ts'
import { UserError } from '../errors.ts'

const TASK = 'toolbox-al tick'

export default async function command(args: ParsedArgs) {
  const project = findProject(process.cwd())
  if (!project) throw new UserError(3, 'проект не найден: выполните toolbox-al init')

  const config = readConfig(project.configPath)
  const command = args.sub ?? 'status'

  if (command === 'status') {
    ok({ enabled: config.scheduler }, config.scheduler ? 'тикер включён' : 'тикер выключен')
    return 0
  }

  if (command === 'enable' || command === 'disable') {
    const enabled = command === 'enable'
    const next = { ...config, scheduler: enabled }
    writeFileSync(project.configPath, JSON.stringify(next, null, 2) + '\n', 'utf8')

    if (boolFlag(args, 'yes') && process.platform === 'win32') {
      try {
        if (enabled) {
          execFileSync('schtasks', ['/create', '/tn', TASK, '/tr', 'toolbox-al tick', '/sc', 'minute', '/f'])
        } else {
          execFileSync('schtasks', ['/delete', '/tn', TASK, '/f'])
        }
      } catch (error) {
        throw new UserError(3, `планировщик не принял задачу: ${String((error as Error).message)}`)
      }
    }

    ok(
      { enabled },
      enabled
        ? 'тикер включён. Для планировщика Windows повторите с --yes'
        : 'тикер выключен',
    )
    return 0
  }

  throw new UserError(3, 'использование: scheduler enable|disable|status [--yes]')
}
