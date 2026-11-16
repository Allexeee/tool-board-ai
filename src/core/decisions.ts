import type { DatabaseSync } from 'node:sqlite'
import { allocateId } from './ids.ts'
import { tx } from './db.ts'
import { appendEvent } from './events.ts'

export interface Decision {
  id: string
  question: string
  choice: string
  alternatives: string[]
  reason: string
  subjectId: string | null
  author: string
  createdAt: string
}

interface Row {
  id: string
  question: string
  choice: string
  alternatives: string | null
  reason: string
  subject_id: string | null
  author: string
  created_at: string
}

const toDecision = (row: Row): Decision => ({
  id: row.id,
  question: row.question,
  choice: row.choice,
  alternatives: row.alternatives ? (JSON.parse(row.alternatives) as string[]) : [],
  reason: row.reason,
  subjectId: row.subject_id,
  author: row.author,
  createdAt: row.created_at,
})

export function addDecision(
  db: DatabaseSync,
  input: {
    question: string
    choice: string
    alternatives?: string[]
    reason: string
    subjectId?: string | null
    author: string
  },
): Decision {
  return tx(db, () => {
    const decision: Decision = {
      id: allocateId(db, 'decision'),
      question: input.question,
      choice: input.choice,
      alternatives: input.alternatives ?? [],
      reason: input.reason,
      subjectId: input.subjectId ?? null,
      author: input.author,
      createdAt: new Date().toISOString(),
    }

    db.prepare(
      'insert into decisions (id, question, choice, alternatives, reason, subject_id, author, created_at) values (?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(
      decision.id,
      decision.question,
      decision.choice,
      JSON.stringify(decision.alternatives),
      decision.reason,
      decision.subjectId,
      decision.author,
      decision.createdAt,
    )

    appendEvent(db, { type: 'decision.added', actor: input.author, subject: decision.id })
    return decision
  })
}

export function listDecisions(db: DatabaseSync, filter: { subjectId?: string } = {}): Decision[] {
  const rows = filter.subjectId
    ? (db.prepare('select * from decisions where subject_id = ? order by created_at').all(filter.subjectId) as unknown as Row[])
    : (db.prepare('select * from decisions order by created_at').all() as unknown as Row[])

  return rows.map(toDecision)
}
