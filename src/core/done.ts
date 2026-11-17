import type { DatabaseSync } from 'node:sqlite'
import { tx } from './db.ts'
import { appendEvent } from './events.ts'
import { getTask, updateTask, type Task } from './tasks.ts'
import { UserError } from '../cli/errors.ts'
import { invalidateAcceptance } from './accept.ts'

export interface Report {
  summary: string
  checks: string[]
  left?: string
  commit?: string
}

export function doneTask(db: DatabaseSync, input: { taskId: string; executor: string; report: Report }): Task {
  return tx(db, () => {
    if (!input.report?.summary?.trim()) {
      throw new UserError(3, 'нужен отчёт: что сделано и чем проверено (--summary)')
    }

    const task = getTask(db, input.taskId)
    if (!task) throw new UserError(3, `задача ${input.taskId} не найдена`)
    if (task.holder !== input.executor) {
      throw new UserError(3, `задача ${task.id} не у исполнителя ${input.executor}`)
    }
    if (task.status !== 'active') {
      throw new UserError(1, `задача ${task.id} не в работе: ${task.status}`)
    }

    const status = task.review === 'none' ? 'done' : 'in_review'
    const updated = updateTask(db, task.id, { status, holder: null, leaseUntil: null })
    db.prepare('delete from hand where task_id = ?').run(task.id)

    appendEvent(db, {
      type: 'task.done',
      actor: input.executor,
      subject: task.id,
      after: input.report,
    })

    return updated
  })
}

export function reopenTask(db: DatabaseSync, input: { taskId: string; actor: string; reason: string }): Task {
  return tx(db, () => {
    if (!input.reason.trim()) throw new UserError(3, 'нужна причина возврата: --reason')

    const task = getTask(db, input.taskId)
    if (!task) throw new UserError(3, `задача ${input.taskId} не найдена`)
    if (task.status !== 'done' && task.status !== 'in_review') {
      throw new UserError(1, `вернуть можно только закрытую задачу, а ${task.id} — ${task.status}`)
    }

    if (task.stageId) {
      const stage = db.prepare('select status from stages where id = ?').get(task.stageId) as
        | { status: string }
        | undefined
      if (stage && ['merged', 'abandoned'].includes(stage.status)) {
        const word = stage.status === 'merged' ? 'слит' : stage.status
        throw new UserError(1, `нельзя переоткрыть задачу ${task.id}: этап ${task.stageId} уже ${word}`)
      }
    }

    const updated = updateTask(db, task.id, { status: 'ready', holder: null, leaseUntil: null })
    invalidateAcceptance(db, task.stageId)
    appendEvent(db, {
      type: 'task.reopened',
      actor: input.actor,
      subject: task.id,
      note: input.reason,
    })

    return updated
  })
}
