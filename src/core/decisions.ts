import type { DatabaseSync } from 'node:sqlite'
import { mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { UserError } from '../cli/errors.ts'
import { nowIso } from './clock.ts'
import { tx } from './db.ts'
import { appendEvent } from './events.ts'
import { allocateId } from './ids.ts'

export type DecisionKind = 'decision' | 'assumption'
export type DecisionStatus = 'actual' | 'cancelled' | 'irrelevant'

export interface Decision {
  id: string
  cardId: string | null
  kind: DecisionKind
  text: string
  status: DecisionStatus
  supersededBy: string | null
  author: string
  createdAt: string
  updatedAt: string
}

interface Row {
  id: string
  card_id: string | null
  kind: string
  text: string
  status: string
  superseded_by: string | null
  author: string
  created_at: string
  updated_at: string
}

const toDecision = (row: Row): Decision => ({
  id: row.id,
  cardId: row.card_id,
  kind: row.kind as DecisionKind,
  text: row.text,
  status: row.status as DecisionStatus,
  supersededBy: row.superseded_by,
  author: row.author,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
})

function getDecision(db: DatabaseSync, id: string): Decision | null {
  const row = db.prepare('select * from decisions where id = ?').get(id) as Row | undefined
  return row ? toDecision(row) : null
}

function requireDecision(db: DatabaseSync, id: string): Decision {
  const decision = getDecision(db, id)
  if (!decision) throw new UserError(3, `решение ${id} не найдено`)
  return decision
}

export function addDecision(
  db: DatabaseSync,
  input: { cardId?: string; kind: DecisionKind; text: string; author: string },
): Decision {
  return tx(db, () => {
    const text = input.text.trim()
    if (!text) throw new UserError(3, 'нужен текст решения')
    const author = input.author.trim()
    if (!author) throw new UserError(3, 'нужен автор решения')
    const kind = input.kind
    if (kind !== 'decision' && kind !== 'assumption') {
      throw new UserError(3, 'kind должен быть decision или assumption')
    }

    const id = allocateId(db, 'decision')
    const at = nowIso()
    db.prepare(
      `insert into decisions (id, card_id, kind, text, status, superseded_by, author, created_at, updated_at)
       values (?, ?, ?, ?, 'actual', null, ?, ?, ?)`,
    ).run(id, input.cardId ?? null, kind, text, author, at, at)

    const decision = getDecision(db, id)!
    appendEvent(db, { type: 'decision.added', actor: author, subject: id, after: decision })
    return decision
  })
}

export function supersedeDecision(
  db: DatabaseSync,
  input: { id: string; by: string; reason: string; actor: string },
): Decision {
  return tx(db, () => {
    const decision = requireDecision(db, input.id)
    const by = requireDecision(db, input.by)
    const reason = input.reason?.trim()
    if (!reason) throw new UserError(3, 'нужна причина: --reason «...»')

    db.prepare(
      `update decisions set status = 'cancelled', superseded_by = ?, updated_at = ? where id = ?`,
    ).run(by.id, nowIso(), decision.id)

    const updated = getDecision(db, decision.id)!
    appendEvent(db, {
      type: 'decision.superseded',
      actor: input.actor,
      subject: decision.id,
      note: reason,
      before: decision,
      after: updated,
    })
    return updated
  })
}

export function obsoleteDecision(
  db: DatabaseSync,
  input: { id: string; reason: string; actor: string },
): Decision {
  return tx(db, () => {
    const decision = requireDecision(db, input.id)
    const reason = input.reason?.trim()
    if (!reason) throw new UserError(3, 'нужна причина: --reason «...»')

    db.prepare(`update decisions set status = 'irrelevant', updated_at = ? where id = ?`).run(
      nowIso(),
      decision.id,
    )

    const updated = getDecision(db, decision.id)!
    appendEvent(db, {
      type: 'decision.obsolete',
      actor: input.actor,
      subject: decision.id,
      note: reason,
      before: decision,
      after: updated,
    })
    return updated
  })
}

export function listDecisions(db: DatabaseSync): Decision[] {
  const rows = db.prepare('select * from decisions order by created_at, rowid').all() as unknown as Row[]
  return rows.map(toDecision)
}

function statusText(d: Decision): string {
  if (d.status === 'cancelled') {
    return `отменено${d.supersededBy ? ` (заменено ${d.supersededBy})` : ''}`
  }
  return 'неактуально'
}

function formatDecision(d: Decision): string {
  const label = d.kind === 'assumption' ? 'Допущение' : 'Решение'
  const heading = [`### ${d.id}`, d.cardId, d.createdAt.slice(0, 10), d.author]
    .filter((part) => part !== null && part !== '')
    .join(' · ')
  const lines = [heading, `**${label}:** ${d.text}`]
  if (d.status !== 'actual') {
    lines.push(`**Статус:** ${statusText(d)}`)
    return lines.map((line) => `~~${line}~~`).join('\n')
  }
  return lines.join('\n')
}

/**
 * Генерирует `docs/board/decisions.md` из базы: актуальные решения сверху в
 * порядке создания, неактуальные — в конце, зачёркнутые. Файл пишется
 * атомарно (temp + rename); ручные правки перезаписываются.
 */
export function renderDecisions(db: DatabaseSync, docsDir: string): string {
  const decisions = listDecisions(db)
  const actual = decisions.filter((d) => d.status === 'actual')
  const inactive = decisions.filter((d) => d.status !== 'actual')

  const blocks: string[] = ['# Решения и допущения']
  for (const d of actual) blocks.push('', formatDecision(d))
  for (const d of inactive) blocks.push('', formatDecision(d))
  const markdown = blocks.join('\n') + '\n'

  mkdirSync(docsDir, { recursive: true })
  const path = join(docsDir, 'decisions.md')
  const tmp = `${path}.tmp`
  writeFileSync(tmp, markdown, 'utf8')
  renameSync(tmp, path)

  return markdown
}
