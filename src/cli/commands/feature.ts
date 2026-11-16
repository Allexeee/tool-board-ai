import { findProject } from '../../core/project.ts'
import { openDb } from '../../core/db.ts'
import { abandonFeature, addFeature, getFeature, listFeatures, rankFeature } from '../../core/features.ts'
import { startFeature } from '../../core/git/worktree.ts'
import { stringFlag, type ParsedArgs } from '../args.ts'
import { ok } from '../output.ts'
import { UserError } from '../errors.ts'

export default async function command(args: ParsedArgs) {
  const project = findProject(process.cwd())
  if (!project) throw new UserError(3, 'проект не найден: выполните toolbox-al init')
  const db = openDb(project.dbPath)

  if (args.sub === 'add') {
    const name = args.positionals[0] ?? stringFlag(args, 'name')
    if (!name) throw new UserError(3, 'не указано имя фичи')
    const feature = addFeature(db, {
      name,
      requestId: stringFlag(args, 'request') ?? null,
      rank: stringFlag(args, 'rank') ? Number(stringFlag(args, 'rank')) : undefined,
    })
    ok(feature, `${feature.id}  ранг ${feature.rank}  ${feature.name}`)
    return 0
  }

  if (args.sub === 'start') {
    const id = args.positionals[0] ?? stringFlag(args, 'id')
    if (!id) throw new UserError(3, 'использование: feature start F1')
    const result = startFeature(db, { root: project.root, featureId: id, config: project.config })
    ok(result, `${id}: ветка ${result.branch}\nкаталог ${result.worktree}`)
    return 0
  }

  if (args.sub === 'abandon') {
    const id = args.positionals[0] ?? stringFlag(args, 'id')
    if (!id) throw new UserError(3, 'использование: feature abandon F1 --reason "почему"')
    const feature = abandonFeature(db, {
      featureId: id,
      actor: 'owner',
      reason: stringFlag(args, 'reason') ?? 'без причины',
    })
    ok(feature, `${feature.id} отменена, ветка сохранена`)
    return 0
  }

  if (args.sub === 'rank') {
    const id = args.positionals[0]
    const rank = Number(args.positionals[1] ?? stringFlag(args, 'rank'))
    if (!id || !Number.isInteger(rank)) throw new UserError(3, 'использование: feature rank F1 2')
    rankFeature(db, id, rank)
    ok({ id, rank }, `${id} → ранг ${rank}`)
    return 0
  }

  if (args.sub === 'show') {
    const feature = getFeature(db, args.positionals[0] ?? '')
    if (!feature) throw new UserError(3, 'фича не найдена')
    ok(
      feature,
      `${feature.id}  ${feature.name}\nранг: ${feature.rank}\nстатус: ${feature.status}\nприёмка: ${feature.reviewPolicy}`,
    )
    return 0
  }

  const features = listFeatures(db)
  ok(
    features,
    features.length === 0
      ? 'фич нет'
      : features.map((f) => `${f.rank}. ${f.id.padEnd(5)} ${f.status.padEnd(8)} ${f.name}`).join('\n'),
  )
  return 0
}
