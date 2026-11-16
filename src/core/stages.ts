import type { DatabaseSync } from 'node:sqlite'
import { childId } from './ids.ts'
import { tx } from './db.ts'
import { appendEvent } from './events.ts'

export type StageStatus = 'planned' | 'active' | 'in_review' | 'accepted' | 'merged' | 'abandoned'
export type Acceptance = 'auto' | 'owner' | 'owner_before_next'

export interface Stage {
  id: string
  featureId: string
  seq: number
  name: string
  goal: string
  appetite: string | null
  status: StageStatus
  acceptance: Acceptance
}

interface Row {
  id: string
  feature_id: string
  seq: number
  name: string
  goal: string
  appetite: string | null
  status: StageStatus
  acceptance: Acceptance
}

const toStage = (row: Row): Stage => ({
  id: row.id,
  featureId: row.feature_id,
  seq: row.seq,
  name: row.name,
  goal: row.goal,
  appetite: row.appetite,
  status: row.status,
  acceptance: row.acceptance,
})

export function addStage(
  db: DatabaseSync,
  input: { featureId: string; name: string; goal: string; appetite: string; acceptance?: Acceptance },
): Stage {
  if (!input.appetite?.trim()) {
    throw new Error('этап без appetite: укажите, сколько времени стоит потратить')
  }
  return tx(db, () => {
    const seq =
      (db.prepare('select coalesce(max(seq), 0) as s from stages where feature_id = ?').get(input.featureId) as {
        s: number
      }).s + 1

    const id = childId(input.featureId, 'stage', seq)
    const stage: Stage = {
      id,
      featureId: input.featureId,
      seq,
      name: input.name,
      goal: input.goal,
      appetite: input.appetite ?? null,
      status: 'planned',
      acceptance: input.acceptance ?? 'auto',
    }

    db.prepare(
      'insert into stages (id, feature_id, seq, name, goal, appetite, status, acceptance) values (?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(
      stage.id,
      stage.featureId,
      stage.seq,
      stage.name,
      stage.goal,
      stage.appetite,
      stage.status,
      stage.acceptance,
    )

    appendEvent(db, {
      type: 'stage.added',
      actor: 'system',
      subject: stage.id,
      after: { featureId: stage.featureId, name: stage.name, appetite: stage.appetite },
    })

    return stage
  })
}

export function listStages(db: DatabaseSync, featureId: string): Stage[] {
  return (
    db.prepare('select * from stages where feature_id = ? order by seq').all(featureId) as unknown as Row[]
  ).map(toStage)
}

export function getStage(db: DatabaseSync, id: string): Stage | null {
  const row = db.prepare('select * from stages where id = ?').get(id) as Row | undefined
  return row ? toStage(row) : null
}

export function activateNextStage(db: DatabaseSync, featureId: string): Stage | null {
  return tx(db, () => {
    const stages = listStages(db, featureId)
    if (stages.some((stage) => stage.status === 'active')) return null

    const next = stages.find((stage) => stage.status === 'planned')
    if (!next) return null

    db.prepare("update stages set status = 'active' where id = ?").run(next.id)
    db.prepare("update features set status = 'active' where id = ? and status = 'approved'").run(featureId)
    return { ...next, status: 'active' }
  })
}
