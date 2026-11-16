import { findProject } from '../../core/project.ts'
import { openDb } from '../../core/db.ts'
import { activateNextStage, addStage, listStages } from '../../core/stages.ts'
import { stringFlag, type ParsedArgs } from '../args.ts'
import { ok } from '../output.ts'
import { UserError } from '../errors.ts'

export default async function command(args: ParsedArgs) {
  const project = findProject(process.cwd())
  if (!project) throw new UserError(3, 'проект не найден: выполните toolbox-al init')
  const db = openDb(project.dbPath)

  if (args.sub === 'add') {
    const featureId = args.positionals[0] ?? stringFlag(args, 'feature')
    const name = args.positionals[1] ?? stringFlag(args, 'name')
    const goal = stringFlag(args, 'goal')
    if (!featureId || !name || !goal) {
      throw new UserError(3, 'использование: stage add F1 "S1" --goal "что можно показать"')
    }
    const stage = addStage(db, { featureId, name, goal })
    ok(stage, `${stage.id}  ${stage.name}`)
    return 0
  }

  if (args.sub === 'activate') {
    const featureId = args.positionals[0]
    if (!featureId) throw new UserError(3, 'не указана фича')
    const stage = activateNextStage(db, featureId)
    ok(stage, stage ? `${stage.id} активен` : 'активировать нечего')
    return 0
  }

  const featureId = args.positionals[0] ?? stringFlag(args, 'feature')
  if (!featureId) throw new UserError(3, 'не указана фича')
  const stages = listStages(db, featureId)
  ok(
    stages,
    stages.length === 0
      ? 'этапов нет'
      : stages.map((s) => `${s.id.padEnd(8)} ${s.status.padEnd(9)} ${s.name}`).join('\n'),
  )
  return 0
}
