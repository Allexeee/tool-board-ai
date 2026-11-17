import type { DatabaseSync } from 'node:sqlite'
import { allocateId } from './ids.ts'
import { appendEvent } from './events.ts'
import { tx } from './db.ts'
import { UserError } from '../cli/errors.ts'

export type FeatureStatus = 'proposed' | 'approved' | 'active' | 'done' | 'cancelled'
export type ReviewPolicy = 'auto' | 'agent' | 'owner'

export interface Feature {
  id: string
  requestId: string | null
  name: string
  rank: number
  status: FeatureStatus
  appetite: string | null
  reviewPolicy: ReviewPolicy
  branch: string | null
  worktree: string | null
  checkCmd: string | null
  createdAt: string
}

interface Row {
  id: string
  request_id: string | null
  name: string
  rank: number
  status: FeatureStatus
  appetite: string | null
  review_policy: ReviewPolicy
  branch: string | null
  worktree: string | null
  check_cmd: string | null
  created_at: string
}

const toFeature = (row: Row): Feature => ({
  id: row.id,
  requestId: row.request_id,
  name: row.name,
  rank: row.rank,
  status: row.status,
  appetite: row.appetite,
  reviewPolicy: row.review_policy,
  branch: row.branch,
  worktree: row.worktree,
  checkCmd: row.check_cmd,
  createdAt: row.created_at,
})

export function addFeature(
  db: DatabaseSync,
  input: {
    requestId?: string | null
    name: string
    rank?: number
    reviewPolicy?: ReviewPolicy
    appetite?: string
  },
): Feature {
  return tx(db, () => {
    const rank = input.rank ?? nextRank(db)
    if (rank < 1) throw new UserError(3, 'ранг начинается с 1')

    db.prepare('update features set rank = rank + 1 where rank >= ?').run(rank)

    const feature: Feature = {
      id: allocateId(db, 'feature'),
      requestId: input.requestId ?? null,
      name: input.name,
      rank,
      status: 'approved',
      appetite: input.appetite ?? null,
      reviewPolicy: input.reviewPolicy ?? 'auto',
      branch: null,
      worktree: null,
      checkCmd: null,
      createdAt: new Date().toISOString(),
    }

    db.prepare(
      'insert into features (id, request_id, name, rank, status, appetite, review_policy, branch, worktree, check_cmd, created_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(
      feature.id,
      feature.requestId,
      feature.name,
      feature.rank,
      feature.status,
      feature.appetite,
      feature.reviewPolicy,
      feature.branch,
      feature.worktree,
      feature.checkCmd,
      feature.createdAt,
    )

    return feature
  })
}

function nextRank(db: DatabaseSync): number {
  const row = db.prepare('select coalesce(max(rank), 0) as r from features').get() as { r: number }
  return row.r + 1
}

export function listFeatures(db: DatabaseSync): Feature[] {
  return (db.prepare('select * from features order by rank, id').all() as unknown as Row[]).map(toFeature)
}

export function getFeature(db: DatabaseSync, id: string): Feature | null {
  const row = db.prepare('select * from features where id = ?').get(id) as Row | undefined
  return row ? toFeature(row) : null
}

export function rankFeature(db: DatabaseSync, featureId: string, rank: number): void {
  tx(db, () => {
    const all = listFeatures(db)
    const target = all.find((f) => f.id === featureId)
    if (!target) throw new UserError(3, `фича ${featureId} не найдена`)
    if (rank < 1 || rank > all.length) throw new UserError(3, `ранг должен быть от 1 до ${all.length}`)

    const reordered = all.filter((f) => f.id !== featureId)
    reordered.splice(rank - 1, 0, target)

    const statement = db.prepare('update features set rank = ? where id = ?')
    reordered.forEach((feature, index) => statement.run(index + 1, feature.id))
  })
}

export function setFeatureCheck(db: DatabaseSync, featureId: string, checkCmd: string | null): void {
  db.prepare('update features set check_cmd = ? where id = ?').run(checkCmd, featureId)
  appendEvent(db, { type: 'feature.check_set', actor: 'system', subject: featureId, after: { check: checkCmd } })
}

export function setFeatureBranch(db: DatabaseSync, featureId: string, branch: string, worktree: string): void {
  db.prepare('update features set branch = ?, worktree = ? where id = ?').run(branch, worktree, featureId)
  appendEvent(db, { type: 'feature.branch_set', actor: 'system', subject: featureId, after: { branch, worktree } })
}

export function abandonFeature(
  db: DatabaseSync,
  input: { featureId: string; actor: string; reason: string },
): Feature {
  return tx(db, () => {
    const feature = getFeature(db, input.featureId)
    if (!feature) throw new UserError(3, `фича ${input.featureId} не найдена`)

    const stages = db.prepare('select id from stages where feature_id = ?').all(feature.id) as Array<{ id: string }>
    for (const stage of stages) {
      db.prepare(
        "update tasks set status = 'cancelled', holder = null, lease_until = null where stage_id = ? and status != 'done'",
      ).run(stage.id)
      db.prepare('delete from hand where task_id in (select id from tasks where stage_id = ?)').run(stage.id)
      db.prepare("update stages set status = 'abandoned' where id = ?").run(stage.id)
    }
    db.prepare("update features set status = 'cancelled' where id = ?").run(feature.id)

    appendEvent(db, {
      type: 'feature.abandoned',
      actor: input.actor,
      subject: feature.id,
      note: input.reason,
    })

    return getFeature(db, feature.id)!
  })
}
