import { buildAdoptPlan, renderAdoptPlan } from '../../core/adopt.ts'
import { openDb } from '../../core/db.ts'
import { findProject } from '../../core/project.ts'
import { boolFlag, type ParsedArgs } from '../args.ts'
import { UserError } from '../errors.ts'
import { ok } from '../output.ts'

const USAGE = 'board adopt --check'

export default async function command(args: ParsedArgs) {
  const project = findProject(process.cwd())
  if (!project) throw new UserError(3, 'проект не найден: выполните board init')
  if (!boolFlag(args, 'check')) throw new UserError(3, USAGE)

  const db = openDb(project.dbPath, { allowOutdated: true, allowNewer: true })
  try {
    const plan = buildAdoptPlan(db, project.root)
    ok(plan, renderAdoptPlan(plan))
    return 0
  } finally {
    db.close()
  }
}
