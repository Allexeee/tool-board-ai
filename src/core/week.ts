import type { DatabaseSync } from 'node:sqlite'
import { featureCost, type FeatureCost } from './cost.ts'
import { listFeatures } from './features.ts'

export interface WeekFeature {
  featureId: string
  featureName: string
  tasks: number
  done: number
  reopens: number
  blocks: number
  hours: number
  urgent: number
}

export interface WeekReport {
  days: number
  since: string
  features: WeekFeature[]
  totals: {
    features: number
    tasks: number
    done: number
    reopens: number
    blocks: number
    hours: number
    urgentShare: number
    averageHours: number
  }
}

/**
 * События, по которым видно работу: по ним задача попадает в окно.
 * `task.created` сюда не входит намеренно — заведение задачи ещё не работа,
 * иначе неделя показывала бы всё, что успели завести, а не то, что двигали.
 */
const WORK_EVENTS = ['task.taken', 'task.done', 'task.edited', 'task.reopened', 'task.blocked']

interface WindowWork {
  tasks: number
  done: number
  urgent: number
  reopens: number
  blocks: number
}

/**
 * Работа по задачам фичи внутри окна. Считаем задачу только если её трогали
 * после since: пожизненные числа под заголовком «за 7 дней» и были враньём.
 */
function windowWork(db: DatabaseSync, featureId: string, since: string): WindowWork {
  const types = WORK_EVENTS.map(() => '?').join(', ')
  const rows = db
    .prepare(
      `select t.id, t.status, t.class as taskClass,
              sum(case when e.type = 'task.reopened' then 1 else 0 end) as reopens,
              sum(case when e.type = 'task.blocked' then 1 else 0 end) as blocks
         from tasks t
         join stages s on s.id = t.stage_id
         join events e on e.subject = t.id
        where s.feature_id = ? and e.at >= ? and e.type in (${types})
        group by t.id, t.status, t.class`,
    )
    .all(featureId, since, ...WORK_EVENTS) as Array<{
    id: string
    status: string
    taskClass: string
    reopens: number
    blocks: number
  }>

  const sum = (pick: (row: (typeof rows)[number]) => number) =>
    rows.reduce((total, row) => total + pick(row), 0)

  return {
    tasks: rows.length,
    done: rows.filter((row) => row.status === 'done').length,
    urgent: rows.filter((row) => row.taskClass === 'expedite').length,
    reopens: sum((row) => row.reopens),
    blocks: sum((row) => row.blocks),
  }
}

/**
 * Часы фичи внутри окна. `featureCost` меряет жизнь фичи целиком, поэтому
 * фича месячной давности давала «300 ч за неделю». Берём только пересечение
 * с окном: от начала окна (или первого события, если оно позже) до последнего
 * события, но не дальше `now`.
 */
function hoursInWindow(cost: FeatureCost, since: number, now: number): number {
  if (!cost.firstAt || !cost.lastAt) return 0

  const first = Date.parse(cost.firstAt)
  const last = Date.parse(cost.lastAt)
  if (Number.isNaN(first) || Number.isNaN(last)) return 0

  const from = Math.max(first, since)
  const to = Math.min(last, now)
  return Math.max(0, Math.round((to - from) / 36e5))
}

/**
 * Обзор недели: не список задач, а поток. Показываем только то, что меняет решения:
 * переоткрытия, блокировки, срочные и время на фичу — и только внутри окна.
 */
export function reviewWeek(db: DatabaseSync, options: { days?: number; now?: Date } = {}): WeekReport {
  const days = options.days ?? 7
  const now = options.now ?? new Date()
  const sinceDate = new Date(now.getTime() - days * 24 * 3600 * 1000)
  const since = sinceDate.toISOString()
  const sinceMs = sinceDate.getTime()

  const features: WeekFeature[] = []
  for (const feature of listFeatures(db)) {
    const cost = featureCost(db, feature.id)
    const lastAt = cost.lastAt ? Date.parse(cost.lastAt) : Number.NaN

    // фича, последнее событие которой было до окна, — это прошлое, а не неделя
    if (Number.isNaN(lastAt) || lastAt < sinceMs) continue

    const work = windowWork(db, feature.id, since)

    features.push({
      featureId: feature.id,
      featureName: feature.name,
      tasks: work.tasks,
      done: work.done,
      reopens: work.reopens,
      blocks: work.blocks,
      hours: hoursInWindow(cost, sinceMs, now.getTime()),
      urgent: work.urgent,
    })
  }

  features.sort((a, b) => b.hours - a.hours || a.featureId.localeCompare(b.featureId))

  const sum = (pick: (item: WeekFeature) => number) => features.reduce((total, item) => total + pick(item), 0)
  const tasks = sum((item) => item.tasks)
  const urgent = sum((item) => item.urgent)

  return {
    days,
    since,
    features,
    totals: {
      features: features.length,
      tasks,
      done: sum((item) => item.done),
      reopens: sum((item) => item.reopens),
      blocks: sum((item) => item.blocks),
      hours: sum((item) => item.hours),
      urgentShare: tasks === 0 ? 0 : Math.round((urgent / tasks) * 100),
      averageHours: features.length === 0 ? 0 : Math.round(sum((item) => item.hours) / features.length),
    },
  }
}

export function formatWeek(report: WeekReport): string {
  if (report.features.length === 0) return `за ${report.days} дней работы не было`

  const lines = report.features.map(
    (item) =>
      `  ${item.featureId.padEnd(5)} ${String(item.hours).padStart(3)} ч · задач ${item.done}/${item.tasks} · переоткрытий ${item.reopens} · блокировок ${item.blocks}${item.urgent > 0 ? ` · срочных ${item.urgent}` : ''}  ${item.featureName}`,
  )
  const totals = report.totals

  return [
    `ЗА ${report.days} ДНЕЙ`,
    ...lines,
    '',
    `фич: ${totals.features} · задач: ${totals.done}/${totals.tasks} · переоткрытий: ${totals.reopens} · блокировок: ${totals.blocks}`,
    `срочных: ${totals.urgentShare}% · в среднем на фичу: ${totals.averageHours} ч`,
  ].join('\n')
}
