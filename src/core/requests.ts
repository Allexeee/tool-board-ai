import type { DatabaseSync } from 'node:sqlite'
import { allocateId } from './ids.ts'
import { tx } from './db.ts'
import { appendEvent } from './events.ts'
import { UserError } from '../cli/errors.ts'

export type RequestStatus = 'inbox' | 'shaping' | 'planned' | 'later' | 'closed'

export interface Request {
  id: string
  title: string
  body: string
  status: RequestStatus
  author: string
  createdAt: string
  reviewAt: string | null
}

interface Row {
  id: string
  title: string
  body: string
  status: RequestStatus
  author: string
  created_at: string
  review_at: string | null
}

const toRequest = (row: Row): Request => ({
  id: row.id,
  title: row.title,
  body: row.body,
  status: row.status,
  author: row.author,
  createdAt: row.created_at,
  reviewAt: row.review_at,
})

export function addRequest(
  db: DatabaseSync,
  input: { title: string; body: string; author: string },
): Request {
  const request: Request = {
    id: allocateId(db, 'request'),
    title: input.title,
    body: input.body,
    status: 'inbox',
    author: input.author,
    createdAt: new Date().toISOString(),
    reviewAt: null,
  }

  db.prepare(
    'insert into requests (id, title, body, status, author, created_at, review_at) values (?, ?, ?, ?, ?, ?, ?)',
  ).run(
    request.id,
    request.title,
    request.body,
    request.status,
    request.author,
    request.createdAt,
    null,
  )

  return request
}

export function getRequest(db: DatabaseSync, id: string): Request | null {
  const row = db.prepare('select * from requests where id = ?').get(id) as Row | undefined
  return row ? toRequest(row) : null
}

export function listRequests(db: DatabaseSync): Request[] {
  return (db.prepare('select * from requests order by created_at, id').all() as unknown as Row[]).map(toRequest)
}

/**
 * Запрос закрыт, когда все его фичи закрыты — это тот же признак, что печатает `request show`.
 * Иначе статус в базе остаётся inbox, и запрос висит в списке, хотя работы по нему нет.
 */
function finishedByFeatures(db: DatabaseSync, requestId: string): boolean {
  const rows = db
    .prepare('select status from features where request_id = ?')
    .all(requestId) as Array<{ status: string }>

  return rows.length > 0 && rows.every((row) => row.status === 'done' || row.status === 'cancelled')
}

export function openRequests(db: DatabaseSync): Request[] {
  return listRequests(db).filter(
    (request) => request.status !== 'closed' && !finishedByFeatures(db, request.id),
  )
}

export type LandState = 'main' | 'dev'

/** Где код запроса: main — выпущено, dev — слито и ждёт релиза, null — ещё ничего не слито. */
export function landState(db: DatabaseSync, requestId: string): LandState | null {
  const features = db
    .prepare('select status from features where request_id = ?')
    .all(requestId) as Array<{ status: string }>
  if (features.length === 0) return null

  const stages = db
    .prepare(
      `select s.status as status, s.merged_at as mergedAt
       from stages s join features f on f.id = s.feature_id
       where f.request_id = ?`,
    )
    .all(requestId) as Array<{ status: string; mergedAt: string | null }>

  const merged = stages.filter((stage) => stage.status === 'merged')
  if (merged.length === 0) return null

  const lastRelease = db.prepare('select max(at) as at from releases').get() as { at: string | null }
  const pending = lastRelease.at
    ? merged.filter((stage) => (stage.mergedAt ?? '') > lastRelease.at!)
    : merged

  const allFeaturesDone = features.every((feature) => feature.status === 'done')
  const allStagesMerged = merged.length === stages.length

  return pending.length === 0 && allFeaturesDone && allStagesMerged ? 'main' : 'dev'
}

export type CloseKind = 'done' | 'cancelled'

export function closeRequest(
  db: DatabaseSync,
  input: { id: string; reason: string; kind?: CloseKind; actor: string },
): Request {
  const reason = input.reason?.trim()
  if (!reason) throw new UserError(3, 'нужна причина закрытия: --reason "почему"')

  const kind = input.kind ?? 'done'
  if (kind !== 'done' && kind !== 'cancelled') {
    throw new UserError(3, `неизвестный вид закрытия: ${kind}. Допустимые: done, cancelled`)
  }

  return tx(db, () => {
    const request = getRequest(db, input.id)
    if (!request) throw new UserError(3, `запрос ${input.id} не найден`)
    if (request.status === 'closed') throw new UserError(1, `запрос ${request.id} уже закрыт`)

    const open = db
      .prepare("select count(*) as c from features where request_id = ? and status not in ('done', 'cancelled')")
      .get(request.id) as { c: number }
    if (open.c > 0) {
      throw new UserError(1, `у запроса ${request.id} есть незакрытые фичи: слейте их или отмените`)
    }

    db.prepare("update requests set status = 'closed', review_at = null where id = ?").run(request.id)
    appendEvent(db, {
      type: 'request.closed',
      actor: input.actor,
      subject: request.id,
      after: { kind },
      note: reason,
    })

    return getRequest(db, request.id)!
  })
}

export function closeKind(db: DatabaseSync, id: string): CloseKind | 'merged' | null {
  const merged = db
    .prepare("select 1 as found from events where type = 'request.merged' and subject = ? limit 1")
    .get(id)
  if (merged) return 'merged'

  const row = db
    .prepare("select after from events where type = 'request.closed' and subject = ? order by id desc limit 1")
    .get(id) as { after: string | null } | undefined

  const kind = row?.after ? (JSON.parse(row.after) as { kind?: CloseKind }).kind : null
  if (kind === 'done' || kind === 'cancelled') return kind

  // закрытия до появления вида писались без него: выводим из состояния фич
  const features = db.prepare('select status from features where request_id = ?').all(id) as Array<{
    status: string
  }>
  if (features.length === 0) return null
  if (features.every((feature) => feature.status === 'done')) return 'done'
  if (features.some((feature) => feature.status === 'cancelled')) return 'cancelled'
  return null
}

export function editRequest(
  db: DatabaseSync,
  input: { id: string; title?: string; body?: string; actor: string },
): Request {
  return tx(db, () => {
    const request = getRequest(db, input.id)
    if (!request) throw new UserError(3, `запрос ${input.id} не найден`)
    if (request.status === 'closed') {
      throw new UserError(1, `запрос ${request.id} закрыт: сначала request reopen`)
    }

    const next: Request = {
      ...request,
      title: input.title?.trim() || request.title,
      body: input.body ?? request.body,
    }

    db.prepare('update requests set title = ?, body = ? where id = ?').run(next.title, next.body, request.id)
    appendEvent(db, {
      type: 'request.edited',
      actor: input.actor,
      subject: request.id,
      before: { title: request.title, body: request.body },
      after: { title: next.title, body: next.body },
    })

    return next
  })
}

export function mergeRequests(
  db: DatabaseSync,
  input: { from: string; to: string; actor: string },
): Request {
  return tx(db, () => {
    const source = getRequest(db, input.from)
    const target = getRequest(db, input.to)

    if (!source) throw new UserError(3, `запрос ${input.from} не найден`)
    if (!target) throw new UserError(3, `запрос ${input.to} не найден`)
    if (source.id === target.id) throw new UserError(3, 'нельзя объединить запрос с собой')
    if (target.status === 'closed') throw new UserError(1, `запрос ${target.id} уже закрыт`)

    const body = `${target.body}\n\n---\nИз ${source.id}: ${source.body}`
    db.prepare('update requests set body = ? where id = ?').run(body, target.id)
    db.prepare("update requests set status = 'closed' where id = ?").run(source.id)

    appendEvent(db, {
      type: 'request.merged',
      actor: input.actor,
      subject: source.id,
      after: { into: target.id },
    })
    appendEvent(db, {
      type: 'request.merged_into',
      actor: input.actor,
      subject: target.id,
      after: { from: source.id },
    })

    return getRequest(db, target.id)!
  })
}

export function laterRequest(
  db: DatabaseSync,
  input: { id: string; until: string; actor: string },
): Request {
  if (!input.until?.trim()) throw new UserError(3, 'нужна дата пересмотра: --until YYYY-MM-DD')

  return tx(db, () => {
    const request = getRequest(db, input.id)
    if (!request) throw new UserError(3, `запрос ${input.id} не найден`)

    db.prepare("update requests set status = 'later', review_at = ? where id = ?").run(input.until, request.id)
    appendEvent(db, {
      type: 'request.later',
      actor: input.actor,
      subject: request.id,
      after: { until: input.until },
    })

    return getRequest(db, request.id)!
  })
}

export function reopenRequest(
  db: DatabaseSync,
  input: { id: string; actor: string },
): Request {
  return tx(db, () => {
    const request = getRequest(db, input.id)
    if (!request) throw new UserError(3, `запрос ${input.id} не найден`)
    if (request.status === 'inbox') throw new UserError(1, `запрос ${request.id} уже в inbox`)

    db.prepare("update requests set status = 'inbox', review_at = null where id = ?").run(request.id)
    appendEvent(db, { type: 'request.reopened', actor: input.actor, subject: request.id })

    return getRequest(db, request.id)!
  })
}

export function removeRequest(db: DatabaseSync, input: { id: string; actor: string }): void {
  return tx(db, () => {
    const request = getRequest(db, input.id)
    if (!request) throw new UserError(3, `запрос ${input.id} не найден`)
    if (request.status === 'closed') {
      throw new UserError(1, `запрос ${request.id} закрыт: сначала request reopen`)
    }

    const features = db
      .prepare('select count(*) as c from features where request_id = ?')
      .get(request.id) as { c: number }
    if (features.c > 0) {
      throw new UserError(1, `у запроса ${request.id} есть фичи: удалять нельзя`)
    }

    const applied = db
      .prepare('select count(*) as c from plans where request_id = ? and applied_at is not null')
      .get(request.id) as { c: number }
    if (applied.c > 0) {
      throw new UserError(1, `запрос ${request.id} уже в работе: удалять нельзя`)
    }

    db.prepare('delete from plans where request_id = ?').run(request.id)
    db.prepare('delete from requests where id = ?').run(request.id)

    appendEvent(db, {
      type: 'request.removed',
      actor: input.actor,
      subject: request.id,
      before: { title: request.title, body: request.body },
    })
  })
}

export function splitRequest(
  db: DatabaseSync,
  input: { id: string; into: string[]; actor: string },
): Request[] {
  return tx(db, () => {
    const request = getRequest(db, input.id)
    if (!request) throw new UserError(3, `запрос ${input.id} не найден`)

    const applied = db
      .prepare('select count(*) as c from plans where request_id = ? and applied_at is not null')
      .get(request.id) as { c: number }
    if (applied.c > 0) {
      throw new UserError(1, `запрос ${request.id} уже в работе: разделить нельзя`)
    }

    const titles = input.into.map((title) => title.trim()).filter(Boolean)
    if (titles.length === 0) throw new UserError(3, 'нужен хотя бы один заголовок для --into')

    const created = titles.map((title) =>
      addRequest(db, { title, body: `Часть запроса ${request.id}`, author: input.actor }),
    )

    db.prepare("update requests set status = 'closed' where id = ?").run(request.id)
    appendEvent(db, {
      type: 'request.split',
      actor: input.actor,
      subject: request.id,
      after: { into: created.map((item) => item.id) },
    })

    return created
  })
}
