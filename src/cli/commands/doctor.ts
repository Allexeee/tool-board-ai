import { findProject } from '../../core/project.ts'
import { openDb } from '../../core/db.ts'
import { doctorReport } from '../../core/doctor.ts'
import { ok } from '../output.ts'
import { UserError } from '../errors.ts'

export default async function command() {
  const project = findProject(process.cwd())
  if (!project) throw new UserError(3, 'проект не найден: выполните toolbox-al init')
  const db = openDb(project.dbPath)

  const report = doctorReport(db, { ownerStaleDays: project.config.ownerStaleDays })
  const bad = report.checks.filter((check) => !check.ok)

  const text =
    report.checks.map((check) => `${check.ok ? 'ок  ' : '!   '}${check.name.padEnd(18)} ${check.detail ?? ''}`).join('\n') +
    (bad.length > 0 ? `\n\nпроблем: ${bad.length}` : '\n\nвсё в порядке')

  ok(report, text)
  return bad.length > 0 ? 1 : 0
}
