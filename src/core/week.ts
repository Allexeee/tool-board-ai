import type { DatabaseSync } from 'node:sqlite'
import { featureCost } from './cost.ts'
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
 * Обзор недели: не список задач, а поток. Показываем только то, что меняет решения:
 * переоткрытия, блокировки, срочные и время на фичу.
 */
export function reviewWeek(db: DatabaseSync, options: { days?: number; now?: Date } = {}): WeekReport {
  const days = options.days ?? 7
  const now = options.now ?? new Date()
  const since = new Date(now.getTime() - days * 24 * 3600 * 1000).toISOString()

  const features: WeekFeature[] = []
  for (const feature of listFeatures(db)) {
    const cost = featureCost(db, feature.id)
    if (!cost.lastAt || cost.lastAt < since) continue

    const urgent = (
      db
        .prepare(
          `select count(*) as c from tasks t join stages s on s.id = t.stage_id
           where s.feature_id = ? and t.class = 'expedite'`,
        )
        .get(feature.id) as { c: number }
    ).c

    features.push({
      featureId: feature.id,
      featureName: feature.name,
      tasks: cost.tasks,
      done: cost.done,
      reopens: cost.reopens,
      blocks: cost.blocks,
      hours: cost.hours,
      urgent,
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
