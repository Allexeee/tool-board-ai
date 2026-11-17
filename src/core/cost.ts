import type { DatabaseSync } from 'node:sqlite'
import { UserError } from '../cli/errors.ts'
import { getFeature } from './features.ts'
import { listStages } from './stages.ts'
import { listTasks } from './tasks.ts'

export interface FeatureCost {
  featureId: string
  featureName: string
  tasks: number
  done: number
  deferred: number
  edits: number
  reopens: number
  blocks: number
  firstAt: string | null
  lastAt: string | null
  hours: number
}

const countEvents = (db: DatabaseSync, ids: string[], type: string): number => {
  if (ids.length === 0) return 0
  const placeholders = ids.map(() => '?').join(', ')
  const row = db
    .prepare(`select count(*) as c from events where type = ? and subject in (${placeholders})`)
    .get(type, ...ids) as { c: number }
  return row.c
}

/**
 * Цена фичи по журналу: задачи, правки, переоткрытия, блокировки и срок.
 * Отдельной таблицы нет намеренно: журнал уже пишет всё, что нужно.
 */
export function featureCost(db: DatabaseSync, featureId: string): FeatureCost {
  const feature = getFeature(db, featureId)
  if (!feature) throw new UserError(3, `фича ${featureId} не найдена`)

  const stages = listStages(db, feature.id)
  const tasks = stages.flatMap((stage) => listTasks(db, { stageId: stage.id }))
  const ids = tasks.map((task) => task.id)

  let firstAt: string | null = null
  let lastAt: string | null = null
  if (ids.length > 0) {
    const placeholders = ids.map(() => '?').join(', ')
    const span = db
      .prepare(`select min(at) as first, max(at) as last from events where subject in (${placeholders})`)
      .get(...ids) as { first: string | null; last: string | null }
    firstAt = span.first
    lastAt = span.last
  }

  const hours =
    firstAt && lastAt ? Math.max(0, Math.round((Date.parse(lastAt) - Date.parse(firstAt)) / 36e5)) : 0

  return {
    featureId: feature.id,
    featureName: feature.name,
    tasks: tasks.length,
    done: tasks.filter((task) => task.status === 'done').length,
    deferred: tasks.filter((task) => task.status === 'deferred').length,
    edits: countEvents(db, ids, 'task.edited'),
    reopens: countEvents(db, ids, 'task.reopened'),
    blocks: countEvents(db, ids, 'task.blocked'),
    firstAt,
    lastAt,
    hours,
  }
}
