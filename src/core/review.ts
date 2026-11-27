import type { DatabaseSync } from 'node:sqlite'
import { UserError } from '../cli/errors.ts'
import { createCard, getCard, listCards } from './cards.ts'
import { nowIso } from './clock.ts'
import { tx } from './db.ts'
import { addDep, refreshReadiness } from './deps.ts'
import { appendEvent, listEvents } from './events.ts'
import { insertIntoQueue } from './queue.ts'
import { listSteps } from './steps.ts'
import { isAncestor, refreshMergeState } from './git.ts'
import type { Card, Severity } from './types.ts'

/** Находка ревью §9.6: severity + текст; skill/scope перекрывают наследуемое. */
export interface FindingInput {
  severity: Severity
  text: string
  skill?: string
  scope?: string[]
  /** Пакетное ревью: карточка пакета, к которой относится находка. */
  cardId?: string
  /** Заполняется при записи пакета: карточка-находка. */
  findingId?: string
}

export interface AddFindingInput {
  cardId: string
  reviewer: string
  severity: Severity
  text: string
  skill?: string
  scope?: string[]
}

/** Есть ли у карточки вердикт run review done после последней сдачи. */
export function hasReviewVerdict(db: DatabaseSync, cardId: string): boolean {
  const lastFinish = (
    db
      .prepare(
        "select max(at) as at from events where subject = ? and type = 'card.finished'",
      )
      .get(cardId) as { at: string | null } | undefined
  )?.at
  if (!lastFinish) {
    return (
      db
        .prepare(
          "select 1 as found from reviews where card_id = ? and kind = 'run' and verdict = 'done' limit 1",
        )
        .get(cardId) !== undefined
    )
  }
  return (
    db
      .prepare(
        "select 1 as found from reviews where card_id = ? and kind = 'run' and verdict = 'done' and at >= ? limit 1",
      )
      .get(cardId, lastFinish) !== undefined
  )
}

/** Владелец явно отказался от ревью: событие card.review_waived, в том числе по старому ID. */
export function hasReviewWaiver(db: DatabaseSync, cardId: string): boolean {
  const card = getCard(db, cardId)
  const ids = [cardId, ...(card?.legacyIds ?? [])]
  const placeholders = ids.map(() => '?').join(', ')
  return (
    db
      .prepare(
        `select 1 as found from events
         where type = 'card.review_waived' and subject in (${placeholders}) limit 1`,
      )
      .get(...ids) !== undefined
  )
}

/** Карточка в пакете: ID, заголовок и merge-коммит. */
export interface PackageCard {
  id: string
  title: string
  commit: string
}

/** Один проход пакетного ревью: что смотрели, чем закончилось. */
export interface ReviewPackage {
  id: number
  at: string
  actor: string
  since: string | null
  verdict: 'done' | 'reopen'
  note: string | null
  cards: PackageCard[]
  commits: string[]
  findings: FindingInput[]
}

interface PackageRow {
  id: number
  at: string
  actor: string
  since: string | null
  verdict: string
  note: string | null
  cards: string
  commits: string
  findings: string
}

const toPackage = (row: PackageRow): ReviewPackage => ({
  id: row.id,
  at: row.at,
  actor: row.actor,
  since: row.since,
  verdict: row.verdict === 'reopen' ? 'reopen' : 'done',
  note: row.note,
  cards: JSON.parse(row.cards) as PackageCard[],
  commits: JSON.parse(row.commits) as string[],
  findings: JSON.parse(row.findings) as FindingInput[],
})

/** Коммит уже прошёл пакетное ревью с вердиктом done. */
export function packageCovers(db: DatabaseSync, commit: string): boolean {
  return (
    db
      .prepare(
        `select 1 as found from review_packages
         where verdict = 'done'
           and exists (select 1 from json_each(review_packages.commits) where json_each.value = ?)
         limit 1`,
      )
      .get(commit) !== undefined
  )
}

export function listPackages(db: DatabaseSync): ReviewPackage[] {
  const rows = db
    .prepare('select * from review_packages order by id')
    .all() as unknown as PackageRow[]
  return rows.map(toPackage)
}

/**
 * Состав следующего пакета: done-карточки в dev вне main, коммиты которых
 * ещё не покрыты проходом с вердиктом done. `since` заменяет базу main.
 */
export function collectPackage(
  db: DatabaseSync,
  root: string,
  options: { since?: string | null } = {},
): PackageCard[] {
  const since = options.since?.trim() || null
  const cards = listCards(db)
    .filter((card) => card.status === 'done' && card.mergeCommit !== null && card.revertedAt === null)
    .map((card) => refreshMergeState(db, root, card))
    .filter((card) =>
      card.inDev && (since ? !isAncestor(root, card.mergeCommit!, since) : !card.inMain),
    )
    .filter((card) => !packageCovers(db, card.mergeCommit!))
    .sort((left, right) => left.id.localeCompare(right.id))

  return cards.map((card) => ({ id: card.id, title: card.title, commit: card.mergeCommit! }))
}

export interface SubmitPackageInput {
  actor: string
  verdict: 'done' | 'reopen'
  note?: string | null
  since?: string | null
  cards: PackageCard[]
  findings?: FindingInput[]
}

/** Записывает проход пакета одной строкой: карточки, коммиты, вердикт, находки. */
export function submitPackage(db: DatabaseSync, input: SubmitPackageInput): ReviewPackage {
  if (input.cards.length === 0) {
    throw new UserError(2, 'пакет ревью пуст: в dev нет непокрытых done-карточек')
  }
  const packageIds = new Set(input.cards.map((card) => card.id))
  for (const item of input.findings ?? []) {
    if (!item.cardId) {
      throw new UserError(3, 'находка пакета без cardId: укажите карточку пакета')
    }
    if (!packageIds.has(item.cardId)) {
      throw new UserError(
        3,
        `находка пакета ссылается на ${item.cardId}, которой нет в пакете`,
      )
    }
  }

  return tx(db, () => {
    const at = nowIso()
    const commits = [...new Set(input.cards.map((card) => card.commit))]
    // Находки пакета идут тем же путём, что и находки рана: карточка, дедупликация,
    // критическая — зависимость исходной карточки.
    const findings: FindingInput[] = []
    for (const item of input.findings ?? []) {
      const finding = addFinding(db, {
        cardId: item.cardId!,
        reviewer: input.actor,
        severity: item.severity,
        text: item.text,
        skill: item.skill,
        scope: item.scope,
      })
      if (finding.severity === 'critical') {
        addDep(db, item.cardId!, finding.id, input.actor, 'критическая находка пакетного ревью')
      }
      findings.push({ ...item, findingId: finding.id })
    }

    const result = db
      .prepare(
        `insert into review_packages (at, actor, since, verdict, note, cards, commits, findings)
         values (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        at,
        input.actor,
        input.since ?? null,
        input.verdict,
        input.note ?? null,
        JSON.stringify(input.cards),
        JSON.stringify(commits),
        JSON.stringify(findings),
      )
    const id = Number(result.lastInsertRowid)
    appendEvent(db, {
      type: 'review.package',
      actor: input.actor,
      subject: `package/${id}`,
      note: input.note ?? undefined,
      after: {
        verdict: input.verdict,
        cards: input.cards.map((card) => card.id),
        commits,
        findings: findings.map((finding) => ({
          cardId: finding.cardId ?? null,
          findingId: finding.findingId ?? null,
          severity: finding.severity,
        })),
      },
    })
    return {
      id,
      at,
      actor: input.actor,
      since: input.since ?? null,
      verdict: input.verdict,
      note: input.note ?? null,
      cards: input.cards,
      commits,
      findings,
    }
  })
}

/** Явный отказ владельца от ревью старой карточки: событие с причиной. */
export function waiveReview(
  db: DatabaseSync,
  input: { cardId: string; actor: string; reason: string },
): Card {
  return tx(db, () => {
    const card = requireCard(db, input.cardId)
    if (input.actor !== OWNER) {
      throw new UserError(3, 'waiver ревью — решение владельца: --as owner')
    }
    const reason = requiredText(input.reason, 'нужна причина waiver')
    const existing = listEvents(db, card.id).some(
      (event) => event.type === 'card.review_waived',
    )
    if (existing) return card

    appendEvent(db, {
      type: 'card.review_waived',
      actor: input.actor,
      subject: card.id,
      note: reason,
      after: { cardId: card.id },
    })
    return getCard(db, card.id)!
  })
}

export interface SubmitVerdictInput {
  cardId: string
  reviewer: string
  verdict: 'done' | 'reopen'
  note?: string
  findings?: FindingInput[]
  planCompliance?: 'done' | 'failed'
  acceptance?: 'done' | 'failed'
  /** Лимит реревью для не-владельца; -1 — без лимита. */
  reopensLimit?: number
  mode?: 'self' | 'subagent'
}

const SEVERITIES: readonly Severity[] = ['critical', 'important', 'other']
const SEVERITY_RANK: Record<Severity, number> = { other: 0, important: 1, critical: 2 }
const OWNER = 'owner'

/** Текст находки для сравнения дублей: без крайних пробелов и повторных пробелов. */
function normalizeFindingText(text: string): string {
  return text.trim().replace(/\s+/g, ' ')
}

/** Исходный текст находки: снимок события `review.finding`, иначе текущее body. */
function findingSourceText(db: DatabaseSync, card: Card): string {
  const row = db
    .prepare(
      `select after from events
       where subject = ? and type = 'review.finding' order by id limit 1`,
    )
    .get(card.id) as { after: string | null } | undefined
  if (row?.after) {
    try {
      const after = JSON.parse(row.after) as { body?: unknown }
      if (typeof after.body === 'string') return after.body
    } catch {
      // битый снимок: сравниваем по текущему body
    }
  }
  return card.body
}

/** Открытая находка той же исходной карточки с тем же текстом, если она есть. */
function findOpenFinding(db: DatabaseSync, originId: string, text: string): Card | null {
  const rows = db
    .prepare(
      `select id from cards
       where origin_card_id = ? and status not in ('done', 'cancelled') order by id`,
    )
    .all(originId) as Array<{ id: string }>
  const wanted = normalizeFindingText(text)
  for (const row of rows) {
    const card = getCard(db, row.id)
    if (card && normalizeFindingText(findingSourceText(db, card)) === wanted) return card
  }
  return null
}

function requireCard(db: DatabaseSync, id: string): Card {
  const card = getCard(db, id)
  if (!card) throw new UserError(3, `карточка ${id} не найдена`)
  return card
}

function requiredText(raw: string, message: string): string {
  const value = raw.trim()
  if (!value) throw new UserError(3, message)
  return value
}

function normalizeSeverity(raw: Severity): Severity {
  if (!SEVERITIES.includes(raw)) {
    throw new UserError(3, `severity — ${SEVERITIES.join(', ')}, а не «${raw}»`)
  }
  return raw
}

/** Карточки на ревью в порядке очереди: по позиции, затем по времени создания. */
export function listReviewCards(db: DatabaseSync): Card[] {
  return listCards(db, { status: 'review' }).sort(
    (left, right) =>
      (left.position ?? Number.MAX_SAFE_INTEGER) -
        (right.position ?? Number.MAX_SAFE_INTEGER) ||
      left.createdAt.localeCompare(right.createdAt) ||
      left.id.localeCompare(right.id),
  )
}

/**
 * Находка — отдельная карточка-запрос в группе проверяемой карточки. Наследует
 * `skill`, `needs_merge` и `scope`; `skill`/`scope` можно перекрыть. `body` — текст.
 * Повтор той же открытой находки не плодит карточку: severity поднимается до
 * максимума, слияние пишется в журнал. Закрытая находка дублем не считается.
 */
export function addFinding(db: DatabaseSync, input: AddFindingInput): Card {
  return tx(db, () => {
    const origin = requireCard(db, input.cardId)
    const reviewer = requiredText(input.reviewer, 'нужен ревьюер')
    const severity = normalizeSeverity(input.severity)
    const text = requiredText(input.text, 'нужен текст находки')

    const duplicate = findOpenFinding(db, origin.id, text)
    if (duplicate) {
      const current = duplicate.severity ?? 'other'
      const highest =
        SEVERITY_RANK[severity] > SEVERITY_RANK[current] ? severity : current
      if (highest !== duplicate.severity) {
        db.prepare('update cards set severity = ?, updated_at = ? where id = ?').run(
          highest,
          nowIso(),
          duplicate.id,
        )
      }
      const merged = getCard(db, duplicate.id)!
      appendEvent(db, {
        type: 'review.finding.merged',
        actor: reviewer,
        subject: duplicate.id,
        before: duplicate,
        after: merged,
        note: `повтор находки из ревью ${origin.id}`,
      })
      return merged
    }

    const finding = createCard(db, {
      group: origin.group,
      title: `Находка ревью ${origin.id}`,
      body: text,
      skill:
        input.skill ??
        (origin.skill === 'owner' ? 'dev' : (origin.skill ?? 'dev')),
      author: reviewer,
      tags: ['review'],
    })

    db.prepare(
      `update cards set phase = 'request', status = 'new', severity = ?, origin_card_id = ?,
       needs_merge = ?, scope = ?, updated_at = ? where id = ?`,
    ).run(
      severity,
      origin.id,
      origin.needsMerge ? 1 : 0,
      JSON.stringify(input.scope ?? origin.scope),
      nowIso(),
      finding.id,
    )

    const updated = getCard(db, finding.id)!
    insertIntoQueue(db, finding.id)
    appendEvent(db, {
      type: 'review.finding',
      actor: reviewer,
      subject: finding.id,
      after: updated,
      note: `из ревью ${origin.id}`,
    })
    return updated
  })
}

/**
 * Вердикт ревью §9.3/§9.6 — одна транзакция: находки, строка `reviews` и переход
 * проверяемой карточки. `done` ставит `done`; `reopen` ставит `ready`, запоминает
 * `previous_holder`, возвращает в начало очереди и вешает зависимости на критические
 * находки. `refreshReadiness` пересчитывает `ready`/`waiting` самой карточки и её
 * зависимых; `revalidateDependents` снимает забронированных зависимых с забега.
 */
export function submitVerdict(
  db: DatabaseSync,
  input: SubmitVerdictInput,
): { card: Card; findings: Card[] } {
  return tx(db, () => {
    const card = requireCard(db, input.cardId)
    const reviewer = requiredText(input.reviewer, 'нужен ревьюер')
    const verdict = input.verdict
    if (verdict !== 'done' && verdict !== 'reopen') {
      throw new UserError(3, `verdict — done или reopen, а не «${verdict}»`)
    }
    if (card.status !== 'review') {
      throw new UserError(3, `карточка ${card.id} не на ревью: ${card.status}`)
    }

    const note = input.note?.trim() || null
    if (verdict === 'reopen' && !note) {
      throw new UserError(3, 'переоткрытие требует причину: --note «...»')
    }
    const planCompliance = input.planCompliance ?? 'done'
    if (planCompliance === 'failed' && verdict !== 'reopen') {
      throw new UserError(3, 'plan failed требует verdict reopen')
    }
    const acceptance = input.acceptance
    if (acceptance !== undefined && acceptance !== 'done' && acceptance !== 'failed') {
      throw new UserError(3, 'acceptance — done или failed')
    }
    if (acceptance === 'failed' && verdict === 'done' && reviewer !== OWNER) {
      throw new UserError(
        3,
        'acceptance не выполнен: verdict reopen или решение владельца (--reviewer owner)',
      )
    }
    // Если план есть, ревьюер обязан дать compliance: иначе сравнить нечего.
    if (listSteps(db, card.id).length > 0 && input.planCompliance === undefined) {
      throw new UserError(3, 'у карточки есть шаги плана: укажите --plan done|failed')
    }
    if (
      verdict === 'reopen' &&
      reviewer !== OWNER &&
      (input.reopensLimit ?? 1) >= 0 &&
      card.reviewReopens >= (input.reopensLimit ?? 1)
    ) {
      throw new UserError(2, `карточка ${card.id}: лимит реревью исчерпан, нужно решение владельца`)
    }

    for (const item of input.findings ?? []) {
      if (item.cardId !== undefined && item.cardId !== card.id) {
        throw new UserError(
          3,
          `находка для ${item.cardId}, а ревью карточки ${card.id}`,
        )
      }
    }
    const findings = (input.findings ?? []).map((item) =>
      addFinding(db, {
        cardId: card.id,
        reviewer,
        severity: item.severity,
        text: item.text,
        skill: item.skill,
        scope: item.scope,
      }),
    )

    db.prepare(
      `insert into reviews (card_id, reviewer, verdict, note, at, kind, mode, spec_rev, plan_compliance, acceptance)
       values (?, ?, ?, ?, ?, 'run', ?, ?, ?, ?)`,
    ).run(
      card.id,
      reviewer,
      verdict,
      note,
      nowIso(),
      input.mode ?? null,
      card.specRev,
      planCompliance,
      acceptance ?? null,
    )

    const at = nowIso()
    if (verdict === 'done') {
      const next = card.ownerAcceptance ? 'acceptance' : 'done'
      db.prepare('update cards set status = ?, done_at = ?, updated_at = ? where id = ?').run(
        next,
        next === 'done' ? at : null,
        at,
        card.id,
      )
      if (card.runId) {
        db.prepare('update run_cards set status = ? where run_id = ? and card_id = ?').run(
          next === 'acceptance' ? 'acceptance' : 'reviewed',
          card.runId,
          card.id,
        )
      }
    } else {
      db.prepare(
        `update cards set status = 'ready', previous_holder = ?, holder = null, run_id = null,
         lease_until = null, attempt = attempt + 1, review_reopens = review_reopens + 1,
         updated_at = ? where id = ?`,
      ).run(card.holder, at, card.id)

      // Переоткрытая карточка возвращается на своё место в очереди.
      if (card.skill !== OWNER) {
        if (getCard(db, card.id)!.position === null) insertIntoQueue(db, card.id)
      }

      for (const finding of findings) {
        if (finding.severity === 'critical') {
          addDep(db, card.id, finding.id, reviewer, 'критическая находка ревью')
        }
      }
    }

    refreshReadiness(db)
    if (verdict === 'reopen') revalidateDependents(db, card.id)

    const updated = getCard(db, card.id)!
    appendEvent(db, {
      type: `review.${verdict}`,
      actor: reviewer,
      subject: card.id,
      before: card,
      after: updated,
      note: note ?? undefined,
    })
    return { card: updated, findings }
  })
}

/**
 * Переоткрытие зависимости §3.4/§9.3: зависимые возвращаются в `waiting`.
 * Не начатые (`ready`) — в `waiting`; забронированные — в `waiting` и сняты с
 * забега (`run_cards` → `dropped`); в работе остаются, их `finish` откажет из-за
 * незакрытой зависимости. Возвращает число изменённых карточек.
 */
export function revalidateDependents(db: DatabaseSync, cardId: string): number {
  return tx(db, () => {
    const rows = db
      .prepare('select from_id from deps where to_id = ? order by from_id')
      .all(cardId) as Array<{ from_id: string }>

    let changed = 0
    for (const row of rows) {
      const dependent = getCard(db, row.from_id)
      if (!dependent) continue

      if (dependent.status === 'booked') {
        const before = dependent
        db.prepare(
          `update cards set status = 'waiting', holder = null, run_id = null, lease_until = null,
           updated_at = ? where id = ?`,
        ).run(nowIso(), dependent.id)
        if (dependent.runId) {
          db.prepare('update run_cards set status = ? where run_id = ? and card_id = ?').run(
            'dropped',
            dependent.runId,
            dependent.id,
          )
        }
        appendEvent(db, {
          type: 'card.revalidated',
          actor: 'system',
          subject: dependent.id,
          before,
          after: getCard(db, dependent.id),
          note: `зависимость ${cardId} переоткрыта`,
        })
        changed++
      } else if (dependent.status === 'ready') {
        const before = dependent
        db.prepare('update cards set status = ?, updated_at = ? where id = ?').run(
          'waiting',
          nowIso(),
          dependent.id,
        )
        appendEvent(db, {
          type: 'card.revalidated',
          actor: 'system',
          subject: dependent.id,
          before,
          after: getCard(db, dependent.id),
          note: `зависимость ${cardId} переоткрыта`,
        })
        changed++
      }
    }
    return changed
  })
}
