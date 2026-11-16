import type { DatabaseSync } from 'node:sqlite'
import { tx } from './db.ts'
import { appendEvent } from './events.ts'
import { getStage, type Stage } from './stages.ts'
import { listTasks, updateTask } from './tasks.ts'
import { UserError } from '../cli/errors.ts'

export function acceptStage(db: DatabaseSync, input: { stageId: string; actor: string }): Stage {
  return tx(db, () => {
    const stage = getStage(db, input.stageId)
    if (!stage) throw new UserError(3, `этап ${input.stageId} не найден`)
    if (stage.status !== 'active' && stage.status !== 'in_review') {
      throw new UserError(1, `принимать можно активный этап, а ${stage.id} — ${stage.status}`)
    }

    db.prepare("update stages set status = 'accepted' where id = ?").run(stage.id)
    appendEvent(db, { type: 'stage.accepted', actor: input.actor, subject: stage.id })

    return getStage(db, stage.id)!
  })
}

export function rejectStage(
  db: DatabaseSync,
  input: { stageId: string; actor: string; reason: string },
): Stage {
  return tx(db, () => {
    const stage = getStage(db, input.stageId)
    if (!stage) throw new UserError(3, `этап ${input.stageId} не найден`)
    if (!['active', 'in_review', 'accepted'].includes(stage.status)) {
      throw new UserError(1, `нельзя вернуть этап в состоянии ${stage.status}`)
    }
    if (!input.reason.trim()) throw new UserError(3, 'нужна причина возврата: --reason')

    db.prepare("update stages set status = 'active' where id = ?").run(stage.id)

    for (const task of listTasks(db, { stageId: stage.id })) {
      if (task.status === 'in_review') {
        updateTask(db, task.id, { status: 'ready', holder: null, leaseUntil: null })
      }
    }

    appendEvent(db, { type: 'stage.rejected', actor: input.actor, subject: stage.id, note: input.reason })
    return getStage(db, stage.id)!
  })
}

export function invalidateAcceptance(db: DatabaseSync, stageId: string | null): void {
  if (!stageId) return
  const stage = getStage(db, stageId)
  if (!stage || stage.status !== 'accepted') return

  db.prepare("update stages set status = 'active' where id = ?").run(stageId)
  appendEvent(db, { type: 'stage.acceptance_invalidated', actor: 'system', subject: stageId })
}
