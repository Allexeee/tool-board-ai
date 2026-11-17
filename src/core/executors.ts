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

export function renameExecutor(
  db: DatabaseSync,
  input: { from: string; to: string; actor: string },
): Executor {
  return tx(db, () => {
    const executor = getExecutor(db, input.from)
    if (!executor) throw new UserError(3, `исполнитель ${input.from} не найден`)
    if (!input.to.trim()) throw new UserError(3, 'нужно новое имя')
    if (input.to === input.from) return executor
    if (getExecutor(db, input.to)) throw new UserError(1, `исполнитель ${input.to} уже есть`)

    db.prepare('update executors set id = ? where id = ?').run(input.to, input.from)
    db.prepare('update tasks set holder = ? where holder = ?').run(input.to, input.from)
    db.prepare('update hand set executor_id = ? where executor_id = ?').run(input.to, input.from)
    appendEvent(db, {
      type: 'executor.renamed',
      actor: input.actor,
      subject: input.to,
      before: { id: input.from },
    })

    return getExecutor(db, input.to)!
  })
}

export function removeExecutor(
  db: DatabaseSync,
  input: { executorId: string; actor: string },
): void {
  return tx(db, () => {
    const executor = getExecutor(db, input.executorId)
    if (!executor) throw new UserError(3, `исполнитель ${input.executorId} не найден`)

    const active = db
      .prepare("select count(*) as c from tasks where holder = ? and status = 'active'")
      .get(executor.id) as { c: number }
    if (active.c > 0) {
      throw new UserError(1, `у исполнителя ${executor.id} есть активная задача: сначала прервите её`)
    }

    db.prepare('delete from hand where executor_id = ?').run(executor.id)
    db.prepare('delete from executors where id = ?').run(executor.id)
    appendEvent(db, { type: 'executor.removed', actor: input.actor, subject: executor.id })
  })
}

export function setSkills(
  db: DatabaseSync,
  input: { executorId: string; skills: string[]; actor: string },
): Executor {
  return tx(db, () => {
    const executor = getExecutor(db, input.executorId)
    if (!executor) throw new UserError(3, `исполнитель ${input.executorId} не найден`)

    const skills = [...new Set(input.skills.map((skill) => skill.trim()).filter(Boolean))]
    if (skills.length === 0) throw new UserError(3, 'нужен хотя бы один навык')

    db.prepare('update executors set skills = ? where id = ?').run(JSON.stringify(skills), executor.id)
    appendEvent(db, {
      type: 'executor.skills_changed',
      actor: input.actor,
      subject: executor.id,
      before: { skills: executor.skills },
      after: { skills },
    })

    return getExecutor(db, executor.id)!
  })
}

export function bindSession(
  db: DatabaseSync,
  input: { executorId: string; session: string; actor: string },
): Executor {
  return tx(db, () => {
    const executor = getExecutor(db, input.executorId)
    if (!executor) throw new UserError(3, `исполнитель ${input.executorId} не найден`)
    if (!input.session.trim()) throw new UserError(3, 'нужен идентификатор сессии: --session <id>')

    db.prepare('update executors set session = ? where id = ?').run(input.session.trim(), executor.id)
    appendEvent(db, {
      type: 'executor.session_bound',
      actor: input.actor,
      subject: executor.id,
      after: { session: input.session.trim() },
    })

    return getExecutor(db, executor.id)!
  })
}

export function resetSession(db: DatabaseSync, input: { executorId: string; actor: string }): Executor {
  return tx(db, () => {
    const executor = getExecutor(db, input.executorId)
    if (!executor) throw new UserError(3, `исполнитель ${input.executorId} не найден`)

    db.prepare('update executors set session = null where id = ?').run(executor.id)
    appendEvent(db, {
      type: 'executor.session_reset',
      actor: input.actor,
      subject: executor.id,
      before: { session: executor.session },
    })

    return getExecutor(db, executor.id)!
  })
}
