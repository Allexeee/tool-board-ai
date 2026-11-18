import type { DatabaseSync } from 'node:sqlite'
import { UserError } from '../cli/errors.ts'
import { allocateId, childId } from './ids.ts'
import { tx } from './db.ts'
import { appendEvent } from './events.ts'
import { refreshReady } from './deps.ts'
import { normalizeScope, validateTaskInput, type NewTask, type TaskClass, type TaskKind, type TaskSeverity, type TaskSize, type TaskScope } from './validate.ts'

export type { NewTask, TaskClass, TaskKind, TaskSeverity, TaskSize, TaskScope } from './validate.ts'

export type TaskStatus =
  | 'planned'
  | 'open'
  | 'ready'
  | 'active'
  | 'blocked'
  | 'needs_owner'
  | 'in_review'
  | 'deferred'
  | 'done'
  | 'cancelled'

export interface Task {
  id: string
  stageId: string | null
  title: string
  kind: TaskKind
  severity: TaskSeverity | null
  dod: string[]
  checkCmd: string | null
  size: TaskSize
  sizeReason: string | null
  skill: string
  class: TaskClass
  scope: TaskScope
  status: TaskStatus
  holder: string | null
  leaseUntil: string | null
  attempts: number
  reason: string | null
  review: 'none' | 'agent' | 'owner'
  session: string | null
  /** Причина и подводные камни: живут в базе, а не в чате оркестратора. */
  note: string | null
  createdAt: string
}

interface Row {
  id: string
  stage_id: string | null
  title: string
  kind: TaskKind
  severity: TaskSeverity | null
  dod: string
  check_cmd: string | null
  size: TaskSize
  size_reason: string | null
  skill: string
  class: TaskClass
  scope: string
  status: TaskStatus
  holder: string | null
  lease_until: string | null
  attempts: number
  reason: string | null
  review: 'none' | 'agent' | 'owner'
  session: string | null
  note: string | null
  created_at: string
}

const toTask = (row: Row): Task => ({
  id: row.id,
  stageId: row.stage_id,
  title: row.title,
  kind: row.kind,
  severity: row.severity,
  dod: JSON.parse(row.dod) as string[],
  checkCmd: row.check_cmd,
  size: row.size,
  sizeReason: row.size_reason,
  skill: row.skill,
  class: row.class,
  scope: row.scope === 'exclusive' ? 'exclusive' : (JSON.parse(row.scope) as string[]),
  status: row.status,
  holder: row.holder,
  leaseUntil: row.lease_until,
  attempts: row.attempts,
  reason: row.reason,
  review: (row.review as 'none' | 'agent' | 'owner') ?? 'agent',
  session: row.session ?? null,
  note: row.note ?? null,
  createdAt: row.created_at,
})

/** Заметка без текста — это отсутствие заметки: пустая строка в базе не нужна. */
const noteOf = (value: string | null | undefined): string | null => {
  const text = value?.trim()
  return text ? text : null
}

// отложенная задача не открыта: её ждёт владелец, а не исполнитель
export function openTasks(db: DatabaseSync): Task[] {
  return listTasks(db).filter(
    (task) => task.status !== 'done' && task.status !== 'cancelled' && task.status !== 'deferred',
  )
}

export function createTask(db: DatabaseSync, input: NewTask & { note?: string }): Task {
  input = { ...input, scope: normalizeScope(input.scope) }
  const { errors, warnings } = validateTaskInput(input)
  if (errors.length > 0) {
    throw new UserError(3, 'задача не создана:\n  ' + errors.join('\n  '))
  }

  return tx(db, () => {
  const stageId = input.stageId ?? null
  if (stageId && !db.prepare('select id from stages where id = ?').get(stageId)) {
    throw new UserError(3, `этап ${stageId} не найден`)
  }

  const suffix = stageId
    ? (db.prepare('select id from tasks where stage_id = ?').all(stageId) as Array<{ id: string }>).reduce(
        (max, row) => Math.max(max, Number(row.id.split('-').at(-1) ?? 0)),
        0,
      ) + 1
    : 0

  if (!stageId && !input.id) {
    const poolId = allocateId(db, 'task')
    input = { ...input, id: poolId }
  }

  const task: Task = {
    id: input.id ?? childId(stageId!, 'task', suffix),
    stageId,
    title: input.title,
    kind: input.kind ?? 'task',
    severity: input.severity ?? null,
    dod: input.dod,
    checkCmd: input.checkCmd ?? null,
    size: input.size,
    sizeReason: input.sizeReason ?? null,
    skill: input.skill,
    class: input.class,
    scope: input.scope,
    status: 'open',
    holder: null,
    leaseUntil: null,
    attempts: 0,
    reason: null,
    review: input.review ?? 'none',
    session: null,
    note: noteOf(input.note),
    createdAt: new Date().toISOString(),
  }

  db.prepare(
    'insert into tasks (id, stage_id, title, kind, severity, dod, check_cmd, size, size_reason, skill, class, scope, status, holder, lease_until, attempts, reason, review, session, note, created_at) ' +
      'values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(
    task.id,
    task.stageId,
    task.title,
    task.kind,
    task.severity,
    JSON.stringify(task.dod),
    task.checkCmd,
    task.size,
    task.sizeReason,
    task.skill,
    task.class,
    task.scope === 'exclusive' ? 'exclusive' : JSON.stringify(task.scope),
    task.status,
    null,
    null,
    0,
    null,
    task.review,
    null,
    task.note,
    task.createdAt,
  )

  appendEvent(db, {
    type: 'task.created',
    actor: 'system',
    subject: task.id,
    after: { title: task.title, size: task.size, warnings },
  })

  return task
  })
}

export function getTask(db: DatabaseSync, id: string): Task | null {
  const row = db.prepare('select * from tasks where id = ?').get(id) as Row | undefined
  return row ? toTask(row) : null
}

export function listTasks(
  db: DatabaseSync,
  filter: { stageId?: string; status?: TaskStatus; holder?: string } = {},
): Task[] {
  const where: string[] = []
  const params: string[] = []

  if (filter.stageId) {
    where.push('stage_id = ?')
    params.push(filter.stageId)
  }
  if (filter.status) {
    where.push('status = ?')
    params.push(filter.status)
  }
  if (filter.holder) {
    where.push('holder = ?')
    params.push(filter.holder)
  }

  const sql =
    'select * from tasks' +
    (where.length ? ' where ' + where.join(' and ') : '') +
    ' order by created_at, id'

  return (db.prepare(sql).all(...params) as unknown as Row[]).map(toTask)
}

export type EditableTask = Partial<{
  title: string
  kind: TaskKind
  severity: TaskSeverity | null
  dod: string[]
  checkCmd: string | null
  size: TaskSize
  sizeReason: string | null
  skill: string
  class: TaskClass
  scope: TaskScope
  note: string | null
}>

export function editTask(
  db: DatabaseSync,
  input: { id: string; actor: string; patch: EditableTask },
): Task {
  return tx(db, () => {
    const current = getTask(db, input.id)
    if (!current) throw new UserError(3, `задача ${input.id} не найдена`)

    // активную задачу правит тот, кто её держит; оркестратор и владелец — поверх очереди
    if (current.status === 'active' && current.holder !== input.actor) {
      const allowed = input.actor === 'orchestrator' || input.actor === 'owner'
      if (!allowed) {
        throw new UserError(
          1,
          `задачу ${current.id} держит ${current.holder}: править может держатель, orchestrator или owner`,
        )
      }
    }

    const merged = {
      stageId: current.stageId,
      title: input.patch.title ?? current.title,
      kind: input.patch.kind ?? current.kind,
      severity: (input.patch.severity ?? current.severity ?? undefined) as TaskSeverity | undefined,
      dod: input.patch.dod ?? current.dod,
      checkCmd: input.patch.checkCmd ?? current.checkCmd ?? undefined,
      size: input.patch.size ?? current.size,
      sizeReason: input.patch.sizeReason ?? current.sizeReason ?? undefined,
      skill: input.patch.skill ?? current.skill,
      class: input.patch.class ?? current.class,
      scope: normalizeScope(input.patch.scope ?? current.scope),
    }
    // заметку не проверяем вместе с DoD и областью: это свободный текст,
    // но пустая заметка означает «заметки нет», а не пустую строку в базе
    const note = input.patch.note === undefined ? current.note : noteOf(input.patch.note)

    const { errors } = validateTaskInput(merged)
    if (errors.length > 0) {
      throw new UserError(3, 'задача не изменена:\n  ' + errors.join('\n  '))
    }

    const keys = (Object.keys(input.patch) as Array<keyof EditableTask>).filter((key) => {
      const patch = input.patch[key]
      if (patch === undefined) return false
      const next = key === 'note' ? note : patch
      return JSON.stringify(next) !== JSON.stringify((current as unknown as Record<string, unknown>)[key])
    })
    if (keys.length === 0) return current

    db.prepare(
      'update tasks set title = ?, kind = ?, severity = ?, dod = ?, check_cmd = ?, size = ?, size_reason = ?, skill = ?, class = ?, scope = ?, note = ? where id = ?',
    ).run(
      merged.title,
      merged.kind,
      merged.severity ?? null,
      JSON.stringify(merged.dod),
      merged.checkCmd ?? null,
      merged.size,
      merged.sizeReason ?? null,
      merged.skill,
      merged.class,
      merged.scope === 'exclusive' ? 'exclusive' : JSON.stringify(merged.scope),
      note,
      current.id,
    )

    const before: Record<string, unknown> = {}
    const after: Record<string, unknown> = {}
    for (const key of keys) {
      before[key] = (current as unknown as Record<string, unknown>)[key]
      after[key] = (getTask(db, current.id) as unknown as Record<string, unknown>)[key]
    }

    appendEvent(db, { type: 'task.edited', actor: input.actor, subject: current.id, before, after })
    return getTask(db, current.id)!
  })
}

export function updateTask(db: DatabaseSync, id: string, patch: Partial<{
  status: TaskStatus
  holder: string | null
  leaseUntil: string | null
  attempts: number
  reason: string | null
}>): Task {
  const current = getTask(db, id)
  if (!current) throw new UserError(3, `задача ${id} не найдена`)

  const next: Task = {
    ...current,
    ...patch,
  }

  db.prepare(
    'update tasks set status = ?, holder = ?, lease_until = ?, attempts = ?, reason = ? where id = ?',
  ).run(next.status, next.holder, next.leaseUntil, next.attempts, next.reason, id)

  // рука хранит только готовые: любая другая задача из неё уходит
  if (next.status !== 'ready') db.prepare('delete from hand where task_id = ?').run(id)

  return next
}

/**
 * Отложить задачу: решение владельца, а не исполнителя. Отложенная задача
 * не держит этап — она перечисляется в результате слияния, но не ждёт его.
 */
export function deferTask(
  db: DatabaseSync,
  input: { id: string; actor: string; reason: string },
): Task {
  return tx(db, () => {
    const reason = input.reason.trim()
    if (!reason) throw new UserError(3, 'нужна причина: --reason "почему задача отложена"')

    const current = getTask(db, input.id)
    if (!current) throw new UserError(3, `задача ${input.id} не найдена`)
    if (current.status === 'deferred') throw new UserError(1, `задача ${current.id} уже отложена`)
    if (current.status === 'done' || current.status === 'cancelled') {
      throw new UserError(1, `задача ${current.id} закрыта: ${current.status}`)
    }

    const updated = updateTask(db, current.id, {
      status: 'deferred',
      holder: null,
      leaseUntil: null,
      reason,
    })

    appendEvent(db, {
      type: 'task.deferred',
      actor: input.actor,
      subject: current.id,
      before: { status: current.status, holder: current.holder },
      after: { status: 'deferred' },
      note: reason,
    })

    return updated
  })
}

/** Вернуть отложенную задачу в работу: статус пересчитывается по зависимостям, как у любой открытой. */
export function undeferTask(db: DatabaseSync, input: { id: string; actor: string }): Task {
  return tx(db, () => {
    const current = getTask(db, input.id)
    if (!current) throw new UserError(3, `задача ${input.id} не найдена`)
    if (current.status !== 'deferred') {
      throw new UserError(1, `задача ${current.id} не отложена: ${current.status}`)
    }

    // возврат в слитый этап дал бы тупик: взять нельзя, закрыть нельзя, а из отчёта релиза она уже ушла
    const stage = db
      .prepare('select status from stages where id = (select stage_id from tasks where id = ?)')
      .get(current.id) as { status: string } | undefined
    if (stage?.status === 'merged') {
      throw new UserError(1, `этап ${current.stageId} уже слит: заведите новую задачу вместо возврата`)
    }

    updateTask(db, current.id, { status: 'open', holder: null, leaseUntil: null, reason: null })
    refreshReady(db)

    const updated = getTask(db, current.id)!
    appendEvent(db, {
      type: 'task.undeferred',
      actor: input.actor,
      subject: current.id,
      before: { status: 'deferred' },
      after: { status: updated.status },
    })

    return updated
  })
}

/**
 * Задача помнит сессию, в которой её делают: следующая доработка начинается там же.
 * `null` стирает: сессии больше нет (или этап слит).
 */
export function setTaskSession(
  db: DatabaseSync,
  input: { id: string; session: string | null; actor: string },
): Task {
  return tx(db, () => {
    const current = getTask(db, input.id)
    if (!current) throw new UserError(3, `задача ${input.id} не найдена`)

    const next = input.session === null ? null : input.session.trim()
    if (next === '') throw new UserError(3, 'пустой идентификатор сессии: нужен --session ses_…')

    if (next === current.session) return current

    db.prepare('update tasks set session = ? where id = ?').run(next, current.id)
    appendEvent(db, {
      type: next ? 'task.session_bound' : 'task.session_reset',
      actor: input.actor,
      subject: current.id,
      before: { session: current.session },
      after: { session: next },
    })

    return getTask(db, current.id)!
  })
}

export function attempt(db: DatabaseSync, id: string, maxAttempts = 3): Task {
  const task = getTask(db, id)
  if (!task) throw new UserError(3, `задача ${id} не найдена`)

  const next = updateTask(db, id, { attempts: task.attempts + 1 })
  if (next.attempts >= maxAttempts && next.status !== 'needs_owner') {
    const escalated = updateTask(db, id, {
      status: 'needs_owner',
      holder: null,
      leaseUntil: null,
      reason: 'attempts_exhausted',
    })
    appendEvent(db, {
      type: 'task.attempts_exhausted',
      actor: 'system',
      subject: id,
      note: `${next.attempts} попыток`,
    })
    void escalated
  }

  return getTask(db, id)!
}


