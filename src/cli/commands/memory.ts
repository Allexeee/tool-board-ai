import { findProject } from '../../core/project.ts'
import { openDb } from '../../core/db.ts'
import { failureMemory, formatFailureMemory } from '../../core/memory.ts'
import type { ParsedArgs } from '../args.ts'
import { ok } from '../output.ts'
import { UserError } from '../errors.ts'

export default async function command(args: ParsedArgs) {
  const project = findProject(process.cwd())
  if (!project) throw new UserError(3, 'проект не найден: выполните toolbox-al init')
  const db = openDb(project.dbPath)

  const path = args.positionals.join(' ').trim()
  if (!path) throw new UserError(3, 'использование: memory <путь>')

  const records = failureMemory(db, path)
  ok(records, formatFailureMemory(records))
  return 0
}
