import { findProject } from '../../core/project.ts'
import { openDb } from '../../core/db.ts'
import { advanceTime } from '../../core/clock.ts'
import { nowView } from '../../core/views.ts'
import { ok } from '../output.ts'
import { UserError } from '../errors.ts'

export default async function command() {
  const project = findProject(process.cwd())
  if (!project) throw new UserError(3, 'проект не найден: выполните toolbox-al init')
  const db = openDb(project.dbPath)
  advanceTime(db)

  const view = nowView(db)

  const features = view.features.map((feature) => {
    const counts = Object.entries(feature.stage.counts)
      .filter(([, value]) => value > 0)
      .map(([status, value]) => `${status} ${value}`)
      .join(' · ')
    return `${feature.rank}. ${feature.id.padEnd(5)} ${feature.name}  [${feature.stage.seq}/${feature.stage.total}] ${counts}`
  })

  const holders = view.holders.map((holder) =>
    holder.task ? `  ${holder.executor.padEnd(12)} держит ${holder.task}` : `  ${holder.executor.padEnd(12)} свободен`,
  )

  const text =
    'ФИЧИ\n' +
    (features.length ? features.join('\n') : '  нет') +
    '\n\nИСПОЛНИТЕЛИ\n' +
    (holders.length ? holders.join('\n') : '  нет') +
    `\n\nждёт вас: ${view.waitingOwner}`

  ok(view, text)
  return 0
}
