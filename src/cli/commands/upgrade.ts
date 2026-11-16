import { findProject } from '../../core/project.ts'
import { openDb } from '../../core/db.ts'
import { applyUpgrade, planUpgrade } from '../../core/upgrade.ts'
import { boolFlag, stringFlag, type ParsedArgs } from '../args.ts'
import { ok } from '../output.ts'
import { UserError } from '../errors.ts'

export default async function command(args: ParsedArgs) {
  const project = findProject(process.cwd())
  if (!project) throw new UserError(3, 'проект не найден: выполните toolbox-al init')
  const db = openDb(project.dbPath)

  const from = stringFlag(args, 'from')
  const yes = boolFlag(args, 'yes')

  const result = applyUpgrade(db, {
    dbPath: project.dbPath,
    configPath: project.configPath,
    root: project.root,
    from,
    yes,
  })

  const plan = result.plan
  const lines = [
    `версия: ${plan.current.current} → ${plan.current.latest ?? plan.current.current}`,
    `схема: ${plan.schemaFrom} → ${plan.schemaTo}`,
    `источник версий: ${plan.current.source}`,
  ]

  if (!plan.outdated) {
    ok({ ...result }, 'обновлять нечего')
    return 0
  }

  if (!result.applied) {
    ok({ ...result }, lines.join('\n') + '\n\nчтобы применить, повторите с --yes')
    return 0
  }

  ok({ ...result }, lines.join('\n') + `\n\nкопия базы: ${result.backup}`)
  return 0
}
