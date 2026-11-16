import { findProject } from '../../core/project.ts'
import { openDb } from '../../core/db.ts'
import { frictionReport } from '../../core/friction.ts'
import { stringFlag, type ParsedArgs } from '../args.ts'
import { ok } from '../output.ts'
import { UserError } from '../errors.ts'

export default async function command(args: ParsedArgs) {
  const project = findProject(process.cwd())
  if (!project) throw new UserError(3, 'проект не найден: выполните toolbox-al init')
  const db = openDb(project.dbPath)

  const days = Number(stringFlag(args, 'days') ?? 7)
  const report = frictionReport(db, { days })

  ok(report, report.map((item) => `${item.name.padEnd(22)} ${String(item.value).padStart(4)}   ${item.hint}`).join('\n'))
  return 0
}
