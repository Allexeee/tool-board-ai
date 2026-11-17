import type { DatabaseSync } from 'node:sqlite'
import { UserError } from '../cli/errors.ts'
import { tx } from './db.ts'
import { appendEvent } from './events.ts'

export type ExecutorKind = 'human' | 'agent'

export type PermissionEffect = 'allow' | 'deny'

/**
 * Правило прав агента. Хранится как JSON-массив и годится для frontmatter
 * агента OpenCode: действие (edit, shell, webfetch), ресурс (шаблон) и эффект.
 */
export interface PermissionRule {
  action: string
  resource: string
  effect: PermissionEffect
}

export const DEFAULT_STEPS = 20
export const MAX_STEPS = 500

export interface Executor {
  id: string
  kind: ExecutorKind
  skills: string[]
  wipLimit: number
  handSize: number
  session: string | null
  lastSeen: string | null
  model: string | null
  permissions: PermissionRule[]
  steps: number
}

interface Row {
  id: string
  kind: ExecutorKind
  skills: string
  wip_limit: number
  hand_size: number
  session: string | null
  last_seen: string | null
  model: string | null
  permissions: string
  steps: number
}

const toExecutor = (row: Row): Executor => ({
  id: row.id,
  kind: row.kind,
  skills: JSON.parse(row.skills) as string[],
  wipLimit: row.wip_limit,
  handSize: row.hand_size,
  session: row.session,
  lastSeen: row.last_seen,
  model: row.model,
  permissions: JSON.parse(row.permissions) as PermissionRule[],
  steps: row.steps,
})

/** Модель хранится как provider/model; null — агент наследует модель родителя. */
export function normalizeModel(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null
  const model = value.trim()
  if (!model || model === 'inherit' || model === 'parent') return null
  if (!/^[^\s/]+\/[^\s/]+$/.test(model)) {
    throw new UserError(
      3,
      `модель «${model}»: нужен формат provider/model, например opencode/gpt-5 (или inherit — наследовать модель родителя)`,
    )
  }
  return model
}

export function normalizeSteps(value: number | string | undefined): number {
  if (value === undefined) return DEFAULT_STEPS
  const steps = typeof value === 'number' ? value : Number(String(value).trim())
  if (!Number.isInteger(steps) || steps < 1 || steps > MAX_STEPS) {
    throw new UserError(3, `шагов должно быть целое число от 1 до ${MAX_STEPS}`)
  }
  return steps
}

/** Правило задаётся строкой action:resource, эффект берётся из флага. */
export function parsePermission(value: string, effect: PermissionEffect): PermissionRule {
  const raw = value.trim()
  const colon = raw.indexOf(':')
  if (colon === -1) {
    throw new UserError(
      3,
      `право «${raw}»: нужен формат action:resource, например shell:git * или edit:*`,
    )
  }

  const action = raw.slice(0, colon).trim()
  const resource = raw.slice(colon + 1).trim()
  if (!action) throw new UserError(3, `право «${raw}»: пустое действие`)
  if (!resource) throw new UserError(3, `право «${raw}»: пустой ресурс`)
  if (!/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(action)) {
    throw new UserError(3, `право «${raw}»: действие «${action}» должно быть одним словом, например shell`)
  }

  return { action, resource, effect }
}

/**
 * --allow/--deny превращаются в упорядоченный список правил.
 * Одинаковые action:resource схлопываются: позже указанное правило побеждает.
 */
export function parsePermissions(input: { allow?: string[]; deny?: string[] }): PermissionRule[] {
  const rules = [
    ...(input.allow ?? []).map((value) => parsePermission(value, 'allow')),
    ...(input.deny ?? []).map((value) => parsePermission(value, 'deny')),
  ]

  const byKey = new Map<string, PermissionRule>()
  for (const rule of rules) byKey.set(`${rule.action}:${rule.resource}`, rule)
  return [...byKey.values()]
}

export function formatPermission(rule: PermissionRule): string {
  return `${rule.effect} ${rule.action}:${rule.resource}`
}

export function addExecutor(
  db: DatabaseSync,
  input: {
    id: string
    kind: ExecutorKind
    skills: string[]
    wipLimit?: number
    handSize?: number
    model?: string | null
    permissions?: PermissionRule[]
    steps?: number
  },
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
    model: normalizeModel(input.model),
    permissions: input.permissions ?? [],
    steps: normalizeSteps(input.steps),
  }

  db.prepare(
    'insert into executors (id, kind, skills, wip_limit, hand_size, session, last_seen, model, permissions, steps) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(
    executor.id,
    executor.kind,
    JSON.stringify(executor.skills),
    executor.wipLimit,
    executor.handSize,
    null,
    executor.lastSeen,
    executor.model,
    JSON.stringify(executor.permissions),
    executor.steps,
  )

  appendEvent(db, {
    type: 'executor.added',
    actor: 'system',
    subject: executor.id,
    after: {
      skills: executor.skills,
      kind: executor.kind,
      model: executor.model,
      permissions: executor.permissions,
      steps: executor.steps,
    },
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
): Executor {
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

    return executor
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

export function setModel(
  db: DatabaseSync,
  input: { executorId: string; model: string | null; actor: string },
): Executor {
  return tx(db, () => {
    const executor = getExecutor(db, input.executorId)
    if (!executor) throw new UserError(3, `исполнитель ${input.executorId} не найден`)

    const model = normalizeModel(input.model)
    db.prepare('update executors set model = ? where id = ?').run(model, executor.id)
    appendEvent(db, {
      type: 'executor.model_changed',
      actor: input.actor,
      subject: executor.id,
      before: { model: executor.model },
      after: { model },
    })

    return getExecutor(db, executor.id)!
  })
}

export function setPermissions(
  db: DatabaseSync,
  input: { executorId: string; permissions: PermissionRule[]; actor: string },
): Executor {
  return tx(db, () => {
    const executor = getExecutor(db, input.executorId)
    if (!executor) throw new UserError(3, `исполнитель ${input.executorId} не найден`)

    db.prepare('update executors set permissions = ? where id = ?').run(
      JSON.stringify(input.permissions),
      executor.id,
    )
    appendEvent(db, {
      type: 'executor.permissions_changed',
      actor: input.actor,
      subject: executor.id,
      before: { permissions: executor.permissions },
      after: { permissions: input.permissions },
    })

    return getExecutor(db, executor.id)!
  })
}

export function setSteps(
  db: DatabaseSync,
  input: { executorId: string; steps: number | string; actor: string },
): Executor {
  return tx(db, () => {
    const executor = getExecutor(db, input.executorId)
    if (!executor) throw new UserError(3, `исполнитель ${input.executorId} не найден`)

    const steps = normalizeSteps(input.steps)
    db.prepare('update executors set steps = ? where id = ?').run(steps, executor.id)
    appendEvent(db, {
      type: 'executor.steps_changed',
      actor: input.actor,
      subject: executor.id,
      before: { steps: executor.steps },
      after: { steps },
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

/**
 * Занятость без задачи: разбор кода, план, проверка чужой работы.
 * Живёт в журнале событий — истёкший срок не считается занятостью сам, без фоновых процессов.
 */
export interface ExecutorBusy {
  reason: string
  until: string
  since: string
}

const unitMs = (unit: string): number => {
  const first = unit.toLowerCase()[0]
  if (first === 'm' || first === 'м') return 60_000
  if (first === 'h' || first === 'ч') return 3_600_000
  if (first === 'd' || first === 'д') return 86_400_000
  return 1_000
}

/**
 * Срок занятости: «30m», «2h», «1d», «45s» или момент ISO.
 * Возвращает ISO — в журнал и в ответы попадает один формат.
 */
export function parseBusyUntil(value: string, now: Date = new Date()): string {
  const raw = value.trim()
  if (!raw) throw new UserError(3, 'нужен срок занятости: --until 30m (2h, 1d или дата ISO)')

  const relative = /^(\d+)\s*(m|min|минут\w*|h|ч|час\w*|d|д|дн\w*|s|с|сек\w*)$/i.exec(raw)
  const until = relative
    ? new Date(now.getTime() + Number(relative[1]) * unitMs(relative[2]))
    : new Date(raw)
  if (Number.isNaN(until.getTime())) {
    throw new UserError(3, `срок «${raw}»: нужен формат 30m, 2h, 1d (или дата ISO)`)
  }
  if (until.getTime() <= now.getTime()) {
    throw new UserError(3, `срок «${raw}» уже прошёл: занятость должна кончаться в будущем`)
  }
  return until.toISOString()
}

/** Текущая занятость или null: снятая, истёкшая и отсутствующая — одно и то же. */
export function busyOf(
  db: DatabaseSync,
  executorId: string,
  at = new Date().toISOString(),
): ExecutorBusy | null {
  const row = db
    .prepare(
      `select at, type, note, after from events
       where subject = ? and type in ('executor.busy', 'executor.free')
       order by id desc limit 1`,
    )
    .get(executorId) as { at: string; type: string; note: string | null; after: string | null } | undefined

  if (!row || row.type !== 'executor.busy') return null

  const after = JSON.parse(row.after ?? '{}') as { reason?: string; until?: string }
  if (!after.until) return null
  if (Date.parse(after.until) <= Date.parse(at)) return null

  return { reason: after.reason ?? row.note ?? '', until: after.until, since: row.at }
}

export function setBusy(
  db: DatabaseSync,
  input: { executorId: string; reason: string; until: string; actor: string; now?: Date },
): ExecutorBusy {
  return tx(db, () => {
    const executor = getExecutor(db, input.executorId)
    if (!executor) throw new UserError(3, `исполнитель ${input.executorId} не найден`)

    const reason = input.reason.trim()
    if (!reason) throw new UserError(3, 'нужна причина занятости: --note "разбор F41"')
    const until = parseBusyUntil(input.until, input.now)

    appendEvent(db, {
      type: 'executor.busy',
      actor: input.actor,
      subject: executor.id,
      note: reason,
      after: { reason, until },
    })

    return busyOf(db, executor.id, (input.now ?? new Date()).toISOString())!
  })
}

/** Снятие занятости: у свободного исполнителя это тихий no-op, а не ошибка. */
export function clearBusy(db: DatabaseSync, input: { executorId: string; actor: string }): ExecutorBusy | null {
  return tx(db, () => {
    const executor = getExecutor(db, input.executorId)
    if (!executor) throw new UserError(3, `исполнитель ${input.executorId} не найден`)

    const busy = busyOf(db, executor.id)
    if (!busy) return null

    appendEvent(db, {
      type: 'executor.free',
      actor: input.actor,
      subject: executor.id,
      note: 'свободен',
      before: { reason: busy.reason, until: busy.until },
    })

    return busy
  })
}
