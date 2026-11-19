import type { DatabaseSync } from 'node:sqlite'
import { UserError } from '../cli/errors.ts'
import { tx } from './db.ts'
import { appendEvent } from './events.ts'
import type { Executor, ExecutorKind } from './types.ts'

export interface NewExecutorInput {
  id: string
  kind: ExecutorKind
  skills: string[]
  runSize?: number
}

export interface ExecutorPatch {
  skills?: string[]
  runSize?: number
}

/** Исполнители заводятся владельцем: отдельного --as у команд нет. */
const OWNER = 'owner'

const ID = /^[a-z0-9][a-z0-9._-]*$/i
const MIN_RUN_SIZE = 1
const MAX_RUN_SIZE = 3
const DEFAULT_RUN_SIZE = 3

interface Row {
  id: string
  kind: string
  skills: string
  run_size: number
  worktree: string | null
  last_seen: string | null
}

const toExecutor = (row: Row): Executor => ({
  id: row.id,
  kind: row.kind as ExecutorKind,
  skills: JSON.parse(row.skills) as string[],
  runSize: row.run_size,
  worktree: row.worktree,
  lastSeen: row.last_seen,
})

function normalizeId(raw: string): string {
  const id = raw.trim()
  if (!ID.test(id)) {
    throw new UserError(
      3,
      `недопустимый id исполнителя «${raw}»: одно слово из латиницы, цифр, точки, дефиса или подчёркивания`,
    )
  }
  return id
}

function normalizeKind(raw: string): ExecutorKind {
  if (raw !== 'human' && raw !== 'agent') {
    throw new UserError(3, `kind исполнителя — human или agent, а не «${raw}»`)
  }
  return raw
}

/** Навыки — набор: пустые отбрасываются, дубликаты схлопываются. */
function normalizeSkills(raw: string[]): string[] {
  const skills = [...new Set(raw.map((skill) => skill.trim()).filter(Boolean))]
  if (skills.length === 0) throw new UserError(3, 'нужен хотя бы один навык исполнителя')
  return skills
}

function normalizeRunSize(raw: number | undefined): number {
  const runSize = raw ?? DEFAULT_RUN_SIZE
  if (!Number.isInteger(runSize) || runSize < MIN_RUN_SIZE || runSize > MAX_RUN_SIZE) {
    throw new UserError(
      3,
      `размер забега — целое число от ${MIN_RUN_SIZE} до ${MAX_RUN_SIZE}`,
    )
  }
  return runSize
}

export function addExecutor(db: DatabaseSync, input: NewExecutorInput): Executor {
  return tx(db, () => {
    const id = normalizeId(input.id)
    if (getExecutor(db, id)) throw new UserError(3, `исполнитель ${id} уже есть`)

    const executor: Executor = {
      id,
      kind: normalizeKind(input.kind),
      skills: normalizeSkills(input.skills),
      runSize: normalizeRunSize(input.runSize),
      worktree: null,
      lastSeen: null,
    }

    db.prepare(
      'insert into executors (id, kind, skills, run_size) values (?, ?, ?, ?)',
    ).run(executor.id, executor.kind, JSON.stringify(executor.skills), executor.runSize)

    appendEvent(db, {
      type: 'executor.added',
      actor: OWNER,
      subject: executor.id,
      after: executor,
    })

    return executor
  })
}

export function getExecutor(db: DatabaseSync, id: string): Executor | null {
  const row = db.prepare('select * from executors where id = ?').get(id) as Row | undefined
  return row ? toExecutor(row) : null
}

export function listExecutors(db: DatabaseSync): Executor[] {
  const rows = db.prepare('select * from executors order by id').all() as unknown as Row[]
  return rows.map(toExecutor)
}

export function updateExecutor(
  db: DatabaseSync,
  input: { id: string; patch: ExecutorPatch },
): Executor {
  return tx(db, () => {
    const executor = getExecutor(db, input.id)
    if (!executor) throw new UserError(3, `исполнитель ${input.id} не найден`)

    const sets: string[] = []
    const params: (string | number)[] = []

    if (input.patch.skills !== undefined) {
      sets.push('skills = ?')
      params.push(JSON.stringify(normalizeSkills(input.patch.skills)))
    }
    if (input.patch.runSize !== undefined) {
      sets.push('run_size = ?')
      params.push(normalizeRunSize(input.patch.runSize))
    }
    if (sets.length === 0) return executor

    params.push(executor.id)
    db.prepare(`update executors set ${sets.join(', ')} where id = ?`).run(...params)

    const updated = getExecutor(db, executor.id)!
    appendEvent(db, {
      type: 'executor.updated',
      actor: OWNER,
      subject: executor.id,
      before: executor,
      after: updated,
    })
    return updated
  })
}

/** Владелец неудаляем; исполнителя с карточками на руках сначала освобождают. */
export function removeExecutor(db: DatabaseSync, id: string): Executor {
  return tx(db, () => {
    const executor = getExecutor(db, id)
    if (!executor) throw new UserError(3, `исполнитель ${id} не найден`)
    if (executor.id === OWNER) throw new UserError(3, 'владельца owner удалить нельзя')

    const held = db
      .prepare('select count(*) as n from cards where holder = ?')
      .get(executor.id) as { n: number }
    if (held.n > 0) {
      throw new UserError(3, `исполнитель ${executor.id} держит карточки: сначала верните их в очередь`)
    }

    db.prepare('delete from executors where id = ?').run(executor.id)
    appendEvent(db, {
      type: 'executor.removed',
      actor: OWNER,
      subject: executor.id,
      before: executor,
    })

    return executor
  })
}
