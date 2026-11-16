import type { DatabaseSync } from 'node:sqlite'
import { tx } from './db.ts'
import { appendEvent } from './events.ts'
import { getTask, updateTask, type Task } from './tasks.ts'
import { ask } from './questions.ts'
import { UserError } from '../cli/errors.ts'

export type BlockReason =
  | 'needs_data'
  | 'needs_access'
  | 'needs_decision'
  | 'impossible'
  | 'budget_exceeded'
  | 'preempted'

const REASONS: BlockReason[] = [
  'needs_data',
  'needs_access',
  'needs_decision',
  'impossible',
  'budget_exceeded',
  'preempted',
]

export function blockTask(
  db: DatabaseSync,
  input: { taskId: string; executor: string; reason: BlockReason; note: string },
): Task {
  return tx(db, () => {
    if (!REASONS.includes(input.reason)) {
      throw new UserError(3, `неизвестная причина ${input.reason}: ${REASONS.join(', ')}`)
    }
    if (!input.note.trim()) throw new UserError(3, 'нужна причина текстом: --note')

    const task = getTask(db, input.taskId)
    if (!task) throw new UserError(3, `задача ${input.taskId} не найдена`)
    if (task.holder !== input.executor) {
      throw new UserError(3, `задача ${task.id} не у исполнителя ${input.executor}`)
    }

    const needsOwner = input.reason === 'needs_decision'
    db.prepare('delete from hand where task_id = ?').run(task.id)

    const updated = updateTask(db, task.id, {
      status: needsOwner ? 'needs_owner' : 'blocked',
      holder: null,
      leaseUntil: null,
      reason: input.reason,
    })

    appendEvent(db, {
      type: 'task.blocked',
      actor: input.executor,
      subject: task.id,
      note: `${input.reason}: ${input.note}`,
    })

    if (needsOwner) {
      ask(db, {
        addressee: 'owner',
        text: `${task.id}: ${input.note}`,
        subjectType: 'task',
        subjectId: task.id,
        deadline: null,
        timeoutPolicy: 'block',
      })
    }

    return updated
  })
}

export function unblockTask(
  db: DatabaseSync,
  input: { taskId: string; actor: string; note?: string },
): Task {
  return tx(db, () => {
    const task = getTask(db, input.taskId)
    if (!task) throw new UserError(3, `задача ${input.taskId} не найдена`)
    if (task.status !== 'blocked' && task.status !== 'needs_owner') {
      throw new UserError(1, `задача ${task.id} не заблокирована: ${task.status}`)
    }

    const updated = updateTask(db, task.id, { status: 'ready', reason: null })
    appendEvent(db, {
      type: 'task.unblocked',
      actor: input.actor,
      subject: task.id,
      note: input.note,
    })
    return updated
  })
}
