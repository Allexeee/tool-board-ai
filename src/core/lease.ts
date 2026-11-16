import type { DatabaseSync } from 'node:sqlite'
import { UserError } from '../cli/errors.ts'
import { tx } from './db.ts'
import { appendEvent } from './events.ts'
import { getExecutor } from './executors.ts'
import { getTask, type Task } from './tasks.ts'
import { nextTask } from './hands.ts'

export interface TakeOptions {
  executor: string
  taskId?: string
  leaseMinutes?: number
  wipLimit?: number
}

export function takeTask(db: DatabaseSync, options: TakeOptions): Task {
  return tx(db, () => {
    const executor = getExecutor(db, options.executor)
    if (!executor) throw new UserError(3, `исполнитель ${options.executor} не найден`)

    const wipLimit = options.wipLimit ?? executor.wipLimit
    const active = db
      .prepare("select count(*) as c from tasks where holder = ? and status = 'active'")
      .get(executor.id) as { c: number }

    if (active.c >= wipLimit) {
      throw new UserError(
        1,
        `WIP: у ${executor.id} уже ${active.c} активная задача (лимит ${wipLimit})`,
      )
    }

    const taskId = options.taskId ?? nextTask(db, executor.id)?.id
    if (!taskId) throw new UserError(1, `у ${executor.id} нет задач`)

    const task = getTask(db, taskId)
    if (!task) throw new UserError(3, `задача ${taskId} не найдена`)

    if (task.class === 'expedite') {
      const activeUrgent = db
        .prepare("select count(*) as c from tasks where holder = ? and status = 'active' and class = 'expedite'")
        .get(executor.id) as { c: number }
      if (activeUrgent.c >= 1) {
        throw new UserError(1, `лимит: у ${executor.id} уже есть активная срочная задача`)
      }
    }

    const reserved = db.prepare('select executor_id from hand where task_id = ?').get(task.id) as
      | { executor_id: string }
      | undefined
    if (reserved && reserved.executor_id !== executor.id) {
      throw new UserError(1, `задача ${task.id} зарезервирована за ${reserved.executor_id}`)
    }

    const leaseUntil = new Date(Date.now() + (options.leaseMinutes ?? 30) * 60_000).toISOString()

    const result = db
      .prepare(
        "update tasks set status = 'active', holder = ?, lease_until = ? where id = ? and holder is null and status in ('ready', 'open')",
      )
      .run(executor.id, leaseUntil, task.id)

    if (Number(result.changes) === 0) {
      throw new UserError(1, `задача ${task.id} уже занята или недоступна`)
    }

    db.prepare('delete from hand where task_id = ?').run(task.id)
    appendEvent(db, {
      type: 'task.taken',
      actor: executor.id,
      subject: task.id,
      after: { leaseUntil },
    })

    return getTask(db, task.id)!
  })
}

export function touchTask(
  db: DatabaseSync,
  options: { executor: string; taskId: string; leaseMinutes?: number },
): Task {
  return tx(db, () => {
    const task = getTask(db, options.taskId)
    if (!task) throw new UserError(3, `задача ${options.taskId} не найдена`)
    if (task.holder !== options.executor || task.status !== 'active') {
      throw new UserError(3, `задача ${task.id} не у исполнителя ${options.executor}`)
    }

    const leaseUntil = new Date(Date.now() + (options.leaseMinutes ?? 30) * 60_000).toISOString()
    db.prepare('update tasks set lease_until = ? where id = ?').run(leaseUntil, task.id)
    return getTask(db, task.id)!
  })
}

export function releaseTask(
  db: DatabaseSync,
  options: { taskId: string; reason: string; actor: string },
): Task {
  return tx(db, () => {
    const task = getTask(db, options.taskId)
    if (!task) throw new UserError(3, `задача ${options.taskId} не найдена`)

    db.prepare(
      "update tasks set status = 'ready', holder = null, lease_until = null, reason = ? where id = ?",
    ).run(options.reason, task.id)
    db.prepare('delete from hand where task_id = ?').run(task.id)

    appendEvent(db, {
      type: 'task.released',
      actor: options.actor,
      subject: task.id,
      note: options.reason,
    })

    return getTask(db, task.id)!
  })
}
