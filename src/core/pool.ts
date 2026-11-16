import type { DatabaseSync } from 'node:sqlite'
import { tx } from './db.ts'
import { appendEvent } from './events.ts'
import { getTask, listTasks, updateTask, type Task } from './tasks.ts'
import { addDep, depsOf } from './deps.ts'
import { UserError } from '../cli/errors.ts'

export function poolTasks(db: DatabaseSync): Task[] {
  return listTasks(db).filter(
    (task) => task.stageId === null && (task.status === 'open' || task.status === 'ready'),
  )
}

export function lastMovement(db: DatabaseSync, taskId: string): string {
  const row = db.prepare('select max(at) as at from events where subject = ?').get(taskId) as {
    at: string | null
  }
  if (row.at) return row.at

  const task = getTask(db, taskId)
  return task?.createdAt ?? new Date(0).toISOString()
}

export function stalePoolTasks(db: DatabaseSync, days = 7): Task[] {
  const threshold = new Date(Date.now() - days * 86_400_000).toISOString()
  return poolTasks(db).filter((task) => lastMovement(db, task.id) < threshold)
}

export function removePoolTask(
  db: DatabaseSync,
  input: { taskId: string; actor: string; reason: string },
): Task {
  return tx(db, () => {
    const task = getTask(db, input.taskId)
    if (!task) throw new UserError(3, `задача ${input.taskId} не найдена`)
    if (task.stageId !== null) {
      throw new UserError(1, `задача ${task.id} не в пуле: у неё есть этап`)
    }
    if (!input.reason.trim()) throw new UserError(3, 'нужна причина: --reason')
    if (task.status === 'active') {
      throw new UserError(1, `задача ${task.id} в работе — сначала прервите её`)
    }

    const updated = updateTask(db, task.id, { status: 'cancelled', holder: null, leaseUntil: null, reason: input.reason })
    appendEvent(db, { type: 'pool.removed', actor: input.actor, subject: task.id, note: input.reason })
    return updated
  })
}

export function mergePoolTasks(
  db: DatabaseSync,
  input: { from: string; to: string; actor: string },
): Task {
  return tx(db, () => {
    const source = getTask(db, input.from)
    const target = getTask(db, input.to)
    if (!source) throw new UserError(3, `задача ${input.from} не найдена`)
    if (!target) throw new UserError(3, `задача ${input.to} не найдена`)
    if (source.id === target.id) throw new UserError(3, 'нельзя объединить задачу с собой')
    if (source.stageId !== null || target.stageId !== null) {
      throw new UserError(1, 'объединять можно только задачи пула')
    }
    if (target.status === 'done' || target.status === 'cancelled') {
      throw new UserError(1, `задача ${target.id} уже ${target.status}`)
    }
    for (const task of [source, target]) {
      if (task.status === 'active') {
        throw new UserError(1, `задача ${task.id} в работе — сначала прервите её`)
      }
    }

    // зависимости источника переезжают на цель, а всё, что зависело от источника, — тоже
    for (const dep of depsOf(db, source.id)) {
      if (dep === target.id) continue
      addDep(db, target.id, dep)
    }
    db.prepare('delete from deps where from_id = ?').run(source.id)
    db.prepare('update or ignore deps set to_id = ? where to_id = ?').run(target.id, source.id)

    const merged = [...new Set([...target.dod, ...source.dod])]
    db.prepare('update tasks set dod = ? where id = ?').run(JSON.stringify(merged), target.id)
    db.prepare(
      "update tasks set status = 'cancelled', holder = null, lease_until = null, reason = ? where id = ?",
    ).run(`объединена с ${target.id}`, source.id)

    appendEvent(db, {
      type: 'pool.merged',
      actor: input.actor,
      subject: source.id,
      after: { into: target.id, dod: merged },
    })

    return getTask(db, target.id)!
  })
}
