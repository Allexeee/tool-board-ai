import { writeBacklog, writeBacklogHtml } from '../../core/backlog.ts'
import { openDb } from '../../core/db.ts'
import { findProject } from '../../core/project.ts'
import { readSettings } from '../../core/settings.ts'
import { boolFlag, stringFlag, type ParsedArgs } from '../args.ts'
import { UserError } from '../errors.ts'
import { ok } from '../output.ts'

export default async function command(args: ParsedArgs) {
  const project = findProject(process.cwd())
  if (!project) throw new UserError(3, 'проект не найден: выполните board init')

  const settings = readSettings(project.root)
  const out = stringFlag(args, 'out')
  if (out) settings.backlog = { ...settings.backlog, path: out }

  const db = openDb(project.dbPath, { allowOutdated: true, allowNewer: true })
  try {
    const htmlOnly = boolFlag(args, 'html')
    const path = htmlOnly ? writeBacklogHtml(db, project.root, settings) : writeBacklog(db, project.root, settings)
    ok({ path }, `бэклог собран: ${path}`)
    return 0
  } finally {
    db.close()
  }
}
