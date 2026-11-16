import { spawnSync } from 'node:child_process'
import type { DatabaseSync } from 'node:sqlite'
import { allocateId } from './ids.ts'
import { tx } from './db.ts'
import { appendEvent } from './events.ts'
import { UserError } from '../cli/errors.ts'

export type GateKind = 'capability' | 'check' | 'approval'

export interface Gate {
  id: string
  routineId: string
  stepId: string | null
  kind: GateKind
  name: string
  once: boolean
  satisfiedAt: string | null
  payload: string | null
}

interface Row {
  id: string
  routine_id: string
  step_id: string | null
  kind: GateKind
  name: string
  once: number
  satisfied_at: string | null
  payload: string | null
}

const toGate = (row: Row): Gate => ({
  id: row.id,
  routineId: row.routine_id,
  stepId: row.step_id,
  kind: row.kind,
  name: row.name,
  once: row.once === 1,
  satisfiedAt: row.satisfied_at,
  payload: row.payload,
})

const KINDS: GateKind[] = ['capability', 'check', 'approval']

export function addGate(
  db: DatabaseSync,
  input: {
    routineId: string
    stepId?: string | null
    kind: GateKind
    name: string
    once?: boolean
    payload?: string
  },
): Gate {
  if (!KINDS.includes(input.kind)) throw new UserError(3, `неизвестный вид гейта: ${input.kind}`)
  if (!input.name?.trim()) throw new UserError(3, 'у гейта должно быть имя')

  return tx(db, () => {
    const gate: Gate = {
      id: allocateId(db, 'gate'),
      routineId: input.routineId,
      stepId: input.stepId ?? null,
      kind: input.kind,
      name: input.name,
      once: input.once ?? false,
      satisfiedAt: null,
      payload: input.payload ?? null,
    }

    db.prepare(
      'insert into gates (id, routine_id, step_id, kind, name, once, satisfied_at, payload) values (?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(
      gate.id,
      gate.routineId,
      gate.stepId,
      gate.kind,
      gate.name,
      gate.once ? 1 : 0,
      null,
      gate.payload,
    )

    appendEvent(db, { type: 'gate.added', actor: 'owner', subject: gate.id })
    return gate
  })
}

export function getGate(db: DatabaseSync, id: string): Gate | null {
  const row = db.prepare('select * from gates where id = ?').get(id) as Row | undefined
  return row ? toGate(row) : null
}

export function listGates(db: DatabaseSync, routineId?: string): Gate[] {
  const rows = routineId
    ? (db.prepare('select * from gates where routine_id = ? order by id').all(routineId) as unknown as Row[])
    : (db.prepare('select * from gates order by id').all() as unknown as Row[])
  return rows.map(toGate)
}

function runCheck(root: string, command: string): boolean {
  const result =
    process.platform === 'win32'
      ? spawnSync('cmd.exe', ['/c', command], { cwd: root, encoding: 'utf8' })
      : spawnSync('sh', ['-c', command], { cwd: root, encoding: 'utf8' })
  return result.status === 0
}

export function checkGate(db: DatabaseSync, gate: Gate, context: { root: string }): { ok: boolean; reason?: string } {
  if (gate.kind === 'approval') {
    return gate.satisfiedAt ? { ok: true } : { ok: false, reason: 'ждёт одобрения владельца' }
  }

  if (gate.kind === 'check') {
    const command = gate.payload ?? gate.name
    return runCheck(context.root, command)
      ? { ok: true }
      : { ok: false, reason: `проверка не прошла: ${command}` }
  }

  const stage = db.prepare('select status from stages where id = ?').get(gate.name) as { status: string } | undefined
  if (stage) {
    const ok = stage.status === 'merged'
    return ok ? { ok: true } : { ok: false, reason: `этап ${gate.name} ещё не слит` }
  }

  const feature = db.prepare('select status from features where id = ?').get(gate.name) as
    | { status: string }
    | undefined
  if (feature) {
    return feature.status === 'done' ? { ok: true } : { ok: false, reason: `фича ${gate.name} не закрыта` }
  }

  return { ok: false, reason: `гейт ${gate.name} ссылается на неизвестный объект` }
}

export function satisfyGate(db: DatabaseSync, input: { gateId: string; actor: string }): Gate {
  return tx(db, () => {
    const gate = getGate(db, input.gateId)
    if (!gate) throw new UserError(3, `гейт ${input.gateId} не найден`)

    db.prepare('update gates set satisfied_at = ? where id = ?').run(new Date().toISOString(), gate.id)
    appendEvent(db, { type: 'gate.satisfied', actor: input.actor, subject: gate.id })
    return getGate(db, gate.id)!
  })
}

export function resetGate(db: DatabaseSync, input: { gateId: string; actor: string }): Gate {
  return tx(db, () => {
    const gate = getGate(db, input.gateId)
    if (!gate) throw new UserError(3, `гейт ${input.gateId} не найден`)

    db.prepare('update gates set satisfied_at = null where id = ?').run(gate.id)
    appendEvent(db, { type: 'gate.reset', actor: input.actor, subject: gate.id })
    return getGate(db, gate.id)!
  })
}
