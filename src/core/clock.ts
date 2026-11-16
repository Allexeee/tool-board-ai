import type { DatabaseSync } from 'node:sqlite'
import { tx } from './db.ts'
import { appendEvent } from './events.ts'
import { refreshReady } from './deps.ts'
import { getExecutor } from './executors.ts'
import { expireQuestions } from './questions.ts'

export interface AdvanceResult {
  expired: string[]
  releasedHands: string[]
}

export function releaseOfflineHands(db: DatabaseSync, now: string, offlineAfterMinutes = 120): string[] {
  const threshold = new Date(new Date(now).getTime() - offlineAfterMinutes * 60_000).toISOString()

  const rows = db
    .prepare(
      'select distinct h.executor_id as id from hand h join executors e on e.id = h.executor_id ' +
        'where e.last_seen is null or e.last_seen < ?',
    )
    .all(threshold) as Array<{ id: string }>

  for (const { id } of rows) {
    db.prepare('delete from hand where executor_id = ?').run(id)
  }

  return rows.map((row) => row.id)
}

export function advanceTime(db: DatabaseSync, now = new Date().toISOString()): AdvanceResult {
  return tx(db, () => {
    const expired = db
      .prepare("select id, attempts, holder from tasks where status = 'active' and lease_until < ?")
      .all(now) as Array<{ id: string; attempts: number; holder: string | null }>

    for (const task of expired) {
      db.prepare(
        "update tasks set status = 'ready', holder = null, lease_until = null, attempts = attempts + 1 where id = ? and status = 'active'",
      ).run(task.id)
      appendEvent(db, {
        type: 'task.lease_expired',
        actor: 'system',
        subject: task.id,
        note: `аренда истекла, попытка ${task.attempts + 1}`,
      })
    }

    const releasedHands = releaseOfflineHands(db, now)
    for (const executor of releasedHands) {
      appendEvent(db, { type: 'hand.released', actor: 'system', subject: executor, note: 'исполнитель offline' })
    }

    expireQuestions(db, now)
    refreshReady(db)

    return { expired: expired.map((task) => task.id), releasedHands }
  })
}

export function assertHoldsTask(db: DatabaseSync, executorId: string, taskId: string): void {
  const executor = getExecutor(db, executorId)
  if (!executor) throw new Error(`исполнитель ${executorId} не найден`)

  const row = db.prepare('select holder from tasks where id = ?').get(taskId) as { holder: string | null } | undefined
  if (!row || row.holder !== executorId) {
    throw new Error(`задача ${taskId} не у исполнителя ${executorId}`)
  }
}
