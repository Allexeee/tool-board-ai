import { findProject } from '../../core/project.ts'
import { openDb } from '../../core/db.ts'
import { activateNextStage, addStage, getStage, listStages } from '../../core/stages.ts'
import { getFeature } from '../../core/features.ts'
import { listTasks } from '../../core/tasks.ts'
import { mergeStage } from '../../core/git/merge.ts'
import { dispatchHands } from '../../core/hands.ts'
import { acceptStage, rejectStage } from '../../core/accept.ts'
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
    const appetite = stringFlag(args, 'appetite')
    if (!featureId || !name || !goal || !appetite) {
      throw new UserError(3, 'использование: stage add F1 "S1" --goal "что можно показать" --appetite "3 дня"')
    }
    const stage = addStage(db, { featureId, name, goal, appetite })
    ok(stage, `${stage.id}  ${stage.name}`)
    return 0
  }

  if (args.sub === 'show') {
    const stageId = args.positionals[0]
    if (!stageId) throw new UserError(3, 'использование: stage show F1.S1')

    const stage = getStage(db, stageId)
    if (!stage) throw new UserError(3, `этап ${stageId} не найден`)

    const feature = getFeature(db, stage.featureId)
    const tasks = listTasks(db, { stageId: stage.id })
    const lines = [
      `${stage.id}  ${stage.name}`,
      `фича: ${feature?.id ?? '?'}  ${feature?.name ?? ''}`,
      `цель: ${stage.goal}`,
      `appetite: ${stage.appetite ?? '—'}`,
      `приёмка: ${stage.acceptance}`,
      `статус: ${stage.status}`,
      '',
      '## Задачи',
      tasks.length === 0
        ? 'нет'
        : tasks.map((task) => `${task.id.padEnd(10)} ${task.status.padEnd(10)} ${task.title}`).join('\n'),
    ]

    ok(stage, lines.join('\n'))
    return 0
  }

  if (args.sub === 'accept') {
    const stageId = args.positionals[0]
    if (!stageId) throw new UserError(3, 'использование: stage accept F1.S1')
    const stage = acceptStage(db, { stageId, actor: 'owner' })

    const next = listStages(db, stage.featureId).find((item) => item.status === 'active')
    const tail = next ? `следующий этап: ${next.id} ${next.name}` : 'следующий этап ещё не активен'
    ok(stage, `${stage.id} принят · ${tail} · дальше stage merge ${stage.id}`)
    return 0
  }

  if (args.sub === 'reject') {
    const stageId = args.positionals[0]
    if (!stageId) throw new UserError(3, 'использование: stage reject F1.S1 --reason "что не так"')
    const stage = rejectStage(db, {
      stageId,
      actor: 'owner',
      reason: stringFlag(args, 'reason') ?? '',
    })
    ok(stage, `${stage.id} возвращён в работу`)
    return 0
  }

  if (args.sub === 'merge') {
    const stageId = args.positionals[0]
    if (!stageId) throw new UserError(3, 'использование: stage merge F1.S1')
    const result = mergeStage(db, { root: project.root, stageId, config: project.config })
    // слитый этап больше не держит себя за одной рукой: свободные руки добираются сразу
    if (result.merged) dispatchHands(db)
    const deferred = result.deferred ?? []
    const tail = deferred.length > 0 ? ` · не вошло: ${deferred.join(', ')}` : ''
    ok(
      result,
      result.merged
        ? `${stageId} слит в ${project.config.branches.dev}${tail}`
        : `${stageId} не слит: ${result.reason}`,
    )
    return result.merged ? 0 : 1
  }

  if (args.sub === 'activate') {
    const featureId = args.positionals[0]
    if (!featureId) throw new UserError(3, 'не указана фича')
    const stage = activateNextStage(db, featureId)
    ok(stage, stage ? `${stage.id} активен` : 'активировать нечего')
    return 0
  }

  const featureId = args.positionals[0] ?? stringFlag(args, 'feature')
  if (!featureId) {
    throw new UserError(3, 'использование: stage list F1 — укажите фичу; все фичи: feature list')
  }
  const stages = listStages(db, featureId)
  ok(
    stages,
    stages.length === 0
      ? 'этапов нет'
      : stages.map((s) => `${s.id.padEnd(8)} ${s.status.padEnd(9)} ${s.name}`).join('\n'),
  )
  return 0
}
