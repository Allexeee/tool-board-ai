import { findProject } from '../../core/project.ts'
import { openDb } from '../../core/db.ts'
import { tick } from '../../core/tick.ts'
import { ok } from '../output.ts'
import { UserError } from '../errors.ts'

export default async function command() {
  const project = findProject(process.cwd())
  if (!project) throw new UserError(3, 'проект не найден: выполните toolbox-al init')
  const db = openDb(project.dbPath)

  const result = tick(db, { root: project.root })
  ok(
    result,
    `материализовано: ${result.materialized}\nисполнено: ${result.executed.length}\nэскалаций: ${result.escalated.length}`,
  )
  return 0
}
