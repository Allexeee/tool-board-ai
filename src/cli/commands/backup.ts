import { backupDatabase } from '../../core/backup.ts'
import { openDb } from '../../core/db.ts'
import { findProject } from '../../core/project.ts'
import { UserError } from '../errors.ts'
import { ok } from '../output.ts'

export default async function command(args: {
  positionals: string[]
}): Promise<number> {
  const project = findProject(process.cwd())
  if (!project) throw new UserError(3, 'проект не найден: выполните board init')
  const db = openDb(project.dbPath)

  try {
    const path = backupDatabase(db, project.dbPath, args.positionals[0])
    ok({ path }, `бэкап: ${path}`)
    return 0
  } finally {
    db.close()
  }
}
