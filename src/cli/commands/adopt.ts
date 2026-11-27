import { buildAdoptPlan, renderAdoptPlan } from '../../core/adopt.ts'
import { openDb } from '../../core/db.ts'
import { findProject } from '../../core/project.ts'
import { modelContext } from '../../core/review-policy.ts'
import { boolFlag, stringFlag, type ParsedArgs } from '../args.ts'
import { UserError } from '../errors.ts'
import { ok } from '../output.ts'

const USAGE = 'board adopt --check [--model-variant low|default|high|max] [--session-model provider/model]'

export default async function command(args: ParsedArgs) {
  const project = findProject(process.cwd())
  if (!project) throw new UserError(3, 'проект не найден: выполните board init')
  if (!boolFlag(args, 'check')) throw new UserError(3, USAGE)

  const variantRaw = stringFlag(args, 'model-variant')
  const variant = variantRaw?.toLowerCase()
  if (variant !== undefined && !['low', 'default', 'high', 'max'].includes(variant)) {
    throw new UserError(3, '--model-variant: low, default, high или max')
  }
  const sessionModel = stringFlag(args, 'session-model')
  const context = modelContext({
    ...process.env,
    ...(variant !== undefined ? { BOARD_MODEL_VARIANT: variant } : {}),
    ...(sessionModel !== undefined ? { BOARD_SESSION_MODEL: sessionModel } : {}),
  })

  const db = openDb(project.dbPath, { allowOutdated: true, allowNewer: true })
  try {
    const plan = buildAdoptPlan(db, project.root, context)
    ok(plan, renderAdoptPlan(plan))
    return 0
  } finally {
    db.close()
  }
}
