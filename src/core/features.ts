import type { DatabaseSync } from 'node:sqlite'
import { allocateId } from './ids.ts'
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
      createdAt: new Date().toISOString(),
    }

    db.prepare(
      'insert into features (id, request_id, name, rank, status, appetite, review_policy, created_at) values (?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(
      feature.id,
      feature.requestId,
      feature.name,
      feature.rank,
      feature.status,
      feature.appetite,
      feature.reviewPolicy,
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
