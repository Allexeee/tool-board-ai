import type { DatabaseSync } from 'node:sqlite'
import { tx } from './db.ts'
import { appendEvent } from './events.ts'
import { getTask, updateTask } from './tasks.ts'
import { UserError } from '../cli/errors.ts'
import { invalidateAcceptance } from './accept.ts'

export type Verdict = 'approved' | 'rejected'

export interface Review {
  id: number
  taskId: string
  reviewer: string
  verdict: Verdict
  comments: string | null
  at: string
}

export function submitReview(
  db: DatabaseSync,
  input: { taskId: string; reviewer: string; verdict: Verdict; note?: string },
): Review {
  return tx(db, () => {
    const task = getTask(db, input.taskId)
    if (!task) throw new UserError(3, `задача ${input.taskId} не найдена`)
    if (task.status !== 'in_review') {
      throw new UserError(1, `задача ${task.id} не на ревью: ${task.status}`)
    }

    const doneBy = db
      .prepare("select actor from events where subject = ? and type = 'task.done' order by id desc limit 1")
      .get(task.id) as { actor: string } | undefined
    if (doneBy?.actor === input.reviewer) {
      throw new UserError(3, 'нельзя ревьюить свою задачу')
    }
    if (input.verdict === 'rejected' && !input.note?.trim()) {
      throw new UserError(3, 'отклонение требует причины: --note')
    }

    const at = new Date().toISOString()
    db.prepare('insert into reviews (task_id, reviewer, verdict, comments, at) values (?, ?, ?, ?, ?)').run(
      task.id,
      input.reviewer,
      input.verdict,
      input.note ?? null,
      at,
    )
    const row = db.prepare('select last_insert_rowid() as id').get() as { id: number }

    if (input.verdict === 'approved') {
      updateTask(db, task.id, { status: 'done', holder: null, leaseUntil: null })
    } else {
      updateTask(db, task.id, { status: 'ready', holder: null, leaseUntil: null, reason: 'review_rejected' })
      invalidateAcceptance(db, task.stageId)
    }

    appendEvent(db, {
      type: `review.${input.verdict}`,
      actor: input.reviewer,
      subject: task.id,
      note: input.note,
    })

    return {
      id: row.id,
      taskId: task.id,
      reviewer: input.reviewer,
      verdict: input.verdict,
      comments: input.note ?? null,
      at,
    }
  })
}
