import type { DatabaseSync } from 'node:sqlite'
import { allocateId } from './ids.ts'
import { tx } from './db.ts'
import { appendEvent } from './events.ts'
import { UserError } from '../cli/errors.ts'

export interface PlanStep {
  title: string
  skill: string
  size: 'XS' | 'S' | 'M' | 'L'
  dod: string[]
  scope: string[]
  deps?: number[]
}

export interface PlanStage {
  name: string
  goal: string
  appetite: string
  steps: PlanStep[]
}

export interface Plan {
  id: string
  requestId: string
  version: number
  title: string
  assumptions: string[]
  stages: PlanStage[]
  approvedAt: string | null
  approvedBy: string | null
  appliedAt: string | null
  featureId: string | null
  createdAt: string
}

interface Row {
  id: string
  request_id: string
  version: number
  title: string
  assumptions: string
  steps: string
  approved_at: string | null
  approved_by: string | null
  applied_at: string | null
  feature_id: string | null
  created_at: string
}

const toPlan = (row: Row): Plan => ({
  id: row.id,
  requestId: row.request_id,
  version: row.version,
  title: row.title,
  assumptions: JSON.parse(row.assumptions) as string[],
  stages: JSON.parse(row.steps) as PlanStage[],
  approvedAt: row.approved_at,
  approvedBy: row.approved_by,
  appliedAt: row.applied_at,
  featureId: row.feature_id,
  createdAt: row.created_at,
})

export function addPlan(
  db: DatabaseSync,
  input: { requestId: string; title: string; assumptions: string[]; stages: PlanStage[] },
): Plan {
  return tx(db, () => {
    const row = db
      .prepare('select coalesce(max(version), 0) as v from plans where request_id = ?')
      .get(input.requestId) as { v: number }

    const plan: Plan = {
      id: allocateId(db, 'plan'),
      requestId: input.requestId,
      version: row.v + 1,
      title: input.title,
      assumptions: input.assumptions,
      stages: input.stages,
      approvedAt: null,
      approvedBy: null,
      appliedAt: null,
      featureId: null,
      createdAt: new Date().toISOString(),
    }

    db.prepare(
      'insert into plans (id, request_id, version, title, assumptions, steps, approved_at, approved_by, applied_at, feature_id, created_at) ' +
        'values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(
      plan.id,
      plan.requestId,
      plan.version,
      plan.title,
      JSON.stringify(plan.assumptions),
      JSON.stringify(plan.stages),
      null,
      null,
      null,
      null,
      plan.createdAt,
    )

    appendEvent(db, {
      type: 'plan.added',
      actor: 'orchestrator',
      subject: plan.id,
      after: { request: plan.requestId, version: plan.version },
    })

    return plan
  })
}

export function getPlan(
  db: DatabaseSync,
  input: { requestId: string; version?: number },
): Plan | null {
  const row = input.version
    ? (db
        .prepare('select * from plans where request_id = ? and version = ?')
        .get(input.requestId, input.version) as Row | undefined)
    : (db
        .prepare('select * from plans where request_id = ? order by version desc limit 1')
        .get(input.requestId) as Row | undefined)

  return row ? toPlan(row) : null
}

export function approvePlan(
  db: DatabaseSync,
  input: { requestId: string; version: number; actor: string },
): Plan {
  return tx(db, () => {
    const plan = getPlan(db, { requestId: input.requestId, version: input.version })
    if (!plan) throw new UserError(3, `план ${input.requestId} v${input.version} не найден`)
    if (plan.approvedAt) throw new UserError(1, `план ${plan.id} уже утверждён`)

    const at = new Date().toISOString()
    db.prepare('update plans set approved_at = ?, approved_by = ? where id = ?').run(at, input.actor, plan.id)
    appendEvent(db, { type: 'plan.approved', actor: input.actor, subject: plan.id })

    return { ...plan, approvedAt: at, approvedBy: input.actor }
  })
}
