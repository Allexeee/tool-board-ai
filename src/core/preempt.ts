import type { DatabaseSync } from 'node:sqlite'
import { tx } from './db.ts'
import { appendEvent } from './events.ts'
import { assertSkill, getExecutor } from './executors.ts'
import { getTask, type Task } from './tasks.ts'
import { isReady } from './deps.ts'
import { scopesOverlap } from './git/scope.ts'
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

    assertSkill(executor, urgent.skill)

    if (urgent.stageId) {
      const stage = db.prepare('select status from stages where id = ?').get(urgent.stageId) as
        | { status: string }
        | undefined
      if (!stage || stage.status !== 'active') {
        throw new UserError(1, `этап ${urgent.stageId} не активен: ${stage?.status ?? 'нет'}`)
      }
    }

    if (!isReady(db, urgent.id)) {
      throw new UserError(1, `у задачи ${urgent.id} не закрыты зависимости`)
    }

    const reserved = db.prepare('select executor_id from hand where task_id = ?').get(urgent.id) as
      | { executor_id: string }
      | undefined
    if (reserved && reserved.executor_id !== executor.id) {
      throw new UserError(1, `задача ${urgent.id} зарезервирована за ${reserved.executor_id}`)
    }

    const foreign = db
      .prepare("select id, scope from tasks where status = 'active' and holder != ?")
      .all(executor.id) as Array<{ id: string; scope: string }>
    for (const other of foreign) {
      const otherScope = other.scope === 'exclusive' ? 'exclusive' : JSON.parse(other.scope)
      if (scopesOverlap(urgent.scope, otherScope)) {
        throw new UserError(1, `область задачи ${urgent.id} пересекается с ${other.id}: прерывать нельзя`)
      }
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
