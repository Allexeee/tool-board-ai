import { findProject } from '../../core/project.ts'
import { openDb } from '../../core/db.ts'
import { advanceTime } from '../../core/clock.ts'
import { nowView, ownerView, type OwnerStageRow } from '../../core/views.ts'
import { boolFlag, type ParsedArgs } from '../args.ts'
import { ok } from '../output.ts'
import { UserError } from '../errors.ts'

export default async function command(args: ParsedArgs) {
  const project = findProject(process.cwd())
  if (!project) throw new UserError(3, 'проект не найден: выполните toolbox-al init')
  const db = openDb(project.dbPath)
  advanceTime(db)

  const all = boolFlag(args, 'all')
  const view = nowView(db, { all })
  const owner = ownerView(db, { all })

  // строки этапов уже отсортированы: готовые → в работе → очередь.
  // фичу без этапов (или только с отменёнными) показываем одной строкой, иначе она исчезает из обзора.
  const stageRows: OwnerStageRow[] = [...owner.stages]
  const shown = new Set(stageRows.map((row) => row.featureId))
  for (const feature of view.features) {
    if (shown.has(feature.id)) continue
    stageRows.push({
      featureId: feature.id,
      featureName: feature.name,
      stageId: '',
      seq: 0,
      total: 0,
      progress: { current: 0, total: 0 },
      status: 'pending',
      name: feature.name,
    })
  }

  const featureWidth = Math.max(0, ...stageRows.map((row) => row.featureId.length))
  const stageWidth = Math.max(0, ...stageRows.map((row) => `[${row.seq}/${row.total}]`.length))
  const progressWidth = Math.max(
    0,
    ...stageRows.map((row) => `${row.progress.current}/${row.progress.total}`.length),
  )
  const decisionsByFeature = new Map(view.features.map((feature) => [feature.id, feature.decisions ?? []]))

  const printed = new Set<string>()
  const features = stageRows.map((row) => {
    const mark = `[${row.seq}/${row.total}]`
    const progress = `${row.progress.current}/${row.progress.total}`
    const line = [
      row.featureId.padEnd(featureWidth),
      mark.padEnd(stageWidth),
      progress.padEnd(progressWidth),
      row.status.padEnd(7),
      row.name,
    ]
      .join('  ')
      .trimEnd()
    if (printed.has(row.featureId)) return line
    printed.add(row.featureId)
    const decisions = decisionsByFeature.get(row.featureId) ?? []
    return [line, ...decisions.map((decision) => `   · ${decision.question} → ${decision.choice}`)].join('\n')
  })

  const pool = view.pool.map((task) => `  ${task.id.padEnd(12)} ${task.title}`)

  const holders = view.holders.map((holder) => {
    const active = holder.active.length > 0 ? `держит ${holder.active.join(', ')}` : 'свободен'
    const hand = holder.hand.length > 0 ? `рука: ${holder.hand.join(', ')}` : 'рука пуста'
    return `  ${holder.executor.padEnd(12)} ${active} · ${hand}`
  })

  const plans = view.plans.map((plan) => `  ${plan.id.padEnd(5)} ${plan.requestId.padEnd(5)} ${plan.title}`)

  const text =
    `Открытых запросов: ${view.requests.length}\n\n` +
    (features.length
      ? features.join('\n')
      : all
        ? 'фич нет'
        : 'фич в работе нет') +
    (view.plans.length ? '\n\nПЛАНЫ НА УТВЕРЖДЕНИЕ\n' + plans.join('\n') : '') +
    (view.unreleased > 0 ? `\n\nНЕ ВЫПУЩЕНО\n  этапов в dev: ${view.unreleased} → release pending` : '') +
    (view.pool.length ? '\n\nПУЛ\n' + pool.join('\n') : '') +
    '\n\nИСПОЛНИТЕЛИ\n' +
    (holders.length ? holders.join('\n') : '  нет') +
    `\n\nждёт вас: ${view.waitingOwner}`

  ok(view, text)
  return 0
}

