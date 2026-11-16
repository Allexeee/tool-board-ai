import type { DatabaseSync } from 'node:sqlite'
import { UserError } from '../cli/errors.ts'
import { tx } from './db.ts'
import { appendEvent } from './events.ts'

export type ExecutorKind = 'human' | 'agent'

export interface Executor {
  id: string
  kind: ExecutorKind
  skills: string[]
  wipLimit: number
  handSize: number
  session: string | null
  lastSeen: string | null
}

interface Row {
  id: string
  kind: ExecutorKind
  skills: string
  wip_limit: number
  hand_size: number
  session: string | null
  last_seen: string | null
}

const toExecutor = (row: Row): Executor => ({
  id: row.id,
  kind: row.kind,
  skills: JSON.parse(row.skills) as string[],
  wipLimit: row.wip_limit,
  handSize: row.hand_size,
  session: row.session,
  lastSeen: row.last_seen,
})

export function addExecutor(
  db: DatabaseSync,
  input: { id: string; kind: ExecutorKind; skills: string[]; wipLimit?: number; handSize?: number },
): Executor {
  if (getExecutor(db, input.id)) throw new UserError(3, `исполнитель ${input.id} уже есть`)

  const executor: Executor = {
    id: input.id,
    kind: input.kind,
    skills: input.skills,
    wipLimit: input.wipLimit ?? 1,
    handSize: input.handSize ?? 5,
    session: null,
    lastSeen: new Date().toISOString(),
  }

  db.prepare(
    'insert into executors (id, kind, skills, wip_limit, hand_size, session, last_seen) values (?, ?, ?, ?, ?, ?, ?)',
  ).run(
    executor.id,
    executor.kind,
    JSON.stringify(executor.skills),
    executor.wipLimit,
    executor.handSize,
    null,
    executor.lastSeen,
  )

  appendEvent(db, {
    type: 'executor.added',
    actor: 'system',
    subject: executor.id,
    after: { skills: executor.skills, kind: executor.kind },
  })

  return executor
}

export function getExecutor(db: DatabaseSync, id: string): Executor | null {
  const row = db.prepare('select * from executors where id = ?').get(id) as Row | undefined
  return row ? toExecutor(row) : null
}

export function listExecutors(db: DatabaseSync): Executor[] {
  const rows = db.prepare('select * from executors order by id').all() as unknown as Row[]
  return rows.map(toExecutor)
}

export function touchExecutor(db: DatabaseSync, id: string, at = new Date().toISOString()): void {
  tx(db, () => {
    db.prepare('update executors set last_seen = ? where id = ?').run(at, id)
  })
}

export function assertSkill(executor: Executor, skill: string): void {
  if (!executor.skills.includes(skill)) {
    throw new UserError(3, `навык ${skill} не найден у исполнителя ${executor.id}`)
  }
}
