import { findProject } from '../../core/project.ts'
import { openDb } from '../../core/db.ts'
import { applyUpgrade, planUpgrade, toolRoot } from '../../core/upgrade.ts'
import { boolFlag, stringFlag, type ParsedArgs } from '../args.ts'
import { ok } from '../output.ts'
import { UserError } from '../errors.ts'

export default async function command(args: ParsedArgs) {
  const project = findProject(process.cwd())
  if (!project) throw new UserError(3, 'проект не найден: выполните toolbox-al init')
  const db = openDb(project.dbPath, { allowOutdated: true })

  const from = stringFlag(args, 'from')
  const yes = boolFlag(args, 'yes')

  if (boolFlag(args, 'check') || !yes) {
    const plan = planUpgrade(db, { toolRoot, configPath: project.configPath, from })
    const lines = [
      `инструмент: ${plan.current.current}`,
      `проект закреплён на: ${plan.pinned}`,
      `схема: ${plan.schemaFrom} → ${plan.schemaTo}`,
      `источник версий: ${plan.current.source}`,
    ]

    if (!plan.outdated) {
      ok({ applied: false, plan }, 'обновлять нечего')
      return 1
    }

    ok({ applied: false, plan }, lines.join('\n') + '\n\nчтобы применить, повторите с --yes')
    return 0
  }

  const result = applyUpgrade(db, {
    dbPath: project.dbPath,
    configPath: project.configPath,
    projectRoot: project.root,
    toolRoot,
    from,
    yes,
  })

  if (!result.applied) {
    ok({ applied: false, plan: result.plan }, 'обновлять нечего')
    return 1
  }

  ok(
    { applied: true, backup: result.backup, plan: result.plan },
    `обновлено до ${result.plan.current.latest ?? result.plan.current.current}\nкопия базы: ${result.backup}`,
  )
  return 0
}
