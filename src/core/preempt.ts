import type { DatabaseSync } from 'node:sqlite'
import { tx } from './db.ts'
import { appendEvent } from './events.ts'
import { getExecutor } from './executors.ts'
import { getTask, type Task } from './tasks.ts'
import { UserError } from '../cli/errors.ts'

export function preempt(
  db: DatabaseSync,
  options: { taskId: string; executor: string; actor: string },
): Task {
  return tx(db, () => {
    const executor = getExecutor(db, options.executor)
    if (!executor) throw new UserError(3, `исполнитель ${options.executor} не найден`)

    const urgent = getTask(db, options.taskId)
    if (!urgent) throw new UserError(3, `задача ${options.taskId} не найдена`)
    if (urgent.class !== 'expedite') {
      throw new UserError(3, `прерывать можно только expedite-задачей, а ${urgent.id} — ${urgent.class}`)
    }
    if (urgent.status !== 'ready') {
      throw new UserError(1, `задача ${urgent.id} не готова: ${urgent.status}`)
    }

    const active = db
      .prepare("select id from tasks where holder = ? and status = 'active'")
      .all(executor.id) as Array<{ id: string }>

    for (const { id } of active) {
      db.prepare(
        "update tasks set status = 'ready', holder = null, lease_until = null, reason = 'preempted' where id = ?",
      ).run(id)
      appendEvent(db, {
        type: 'task.preempted',
        actor: options.actor,
        subject: id,
        note: `вытеснено задачей ${urgent.id}`,
      })
    }

    const leaseUntil = new Date(Date.now() + 30 * 60_000).toISOString()
    db.prepare(
      "update tasks set status = 'active', holder = ?, lease_until = ? where id = ?",
    ).run(executor.id, leaseUntil, urgent.id)
    db.prepare('delete from hand where task_id = ?').run(urgent.id)

    appendEvent(db, {
      type: 'task.taken',
      actor: executor.id,
      subject: urgent.id,
      note: active.length > 0 ? `вытеснил ${active.map((row) => row.id).join(', ')}` : undefined,
    })

    return getTask(db, urgent.id)!
  })
}
