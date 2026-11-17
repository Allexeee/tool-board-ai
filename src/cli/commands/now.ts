import { findProject } from '../../core/project.ts'
import { openDb } from '../../core/db.ts'
import { advanceTime } from '../../core/clock.ts'
import { nowView } from '../../core/views.ts'
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

  const features = view.features.map((feature) => {
    const counts = Object.entries(feature.stage.counts)
      .filter(([, value]) => value > 0)
      .map(([status, value]) => `${status} ${value}`)
      .join(' · ')
    const mark = feature.finished
      ? `[${feature.stage.done}/${feature.stage.total}] завершена`
      : `[${feature.stage.seq}/${feature.stage.total}]`
    const line = `${feature.rank}. ${feature.id.padEnd(5)} ${feature.name}  ${mark} ${counts}`.trimEnd()
    const decisions = feature.decisions.map((decision) => `   · ${decision.question} → ${decision.choice}`)
    return [line, ...decisions].join('\n')
  })

  const pool = view.pool.map((task) => `  ${task.id.padEnd(12)} ${task.title}`)

  const holders = view.holders.map((holder) => {
    const active = holder.active.length > 0 ? `держит ${holder.active.join(', ')}` : 'свободен'
    const hand = holder.hand.length > 0 ? `рука: ${holder.hand.join(', ')}` : 'рука пуста'
    return `  ${holder.executor.padEnd(12)} ${active} · ${hand}`
  })

  const requests = view.requests.map((request) => `  ${request.id.padEnd(5)} ${request.title}`)
  const plans = view.plans.map((plan) => `  ${plan.id.padEnd(5)} ${plan.requestId.padEnd(5)} ${plan.title}`)

  const text =
    'ФИЧИ\n' +
    (features.length
      ? features.join('\n')
      : all
        ? '  фич нет'
        : '  фич в работе нет') +
    (view.requests.length ? '\n\nЗАПРОСЫ В INBOX\n' + requests.join('\n') : '') +
    (view.plans.length ? '\n\nПЛАНЫ НА УТВЕРЖДЕНИЕ\n' + plans.join('\n') : '') +
    (view.unreleased > 0 ? `\n\nНЕ ВЫПУЩЕНО\n  этапов в dev: ${view.unreleased} → release pending` : '') +
    (view.pool.length ? '\n\nПУЛ\n' + pool.join('\n') : '') +
    '\n\nИСПОЛНИТЕЛИ\n' +
    (holders.length ? holders.join('\n') : '  нет') +
    `\n\nждёт вас: ${view.waitingOwner}`

  ok(view, text)
  return 0
}

