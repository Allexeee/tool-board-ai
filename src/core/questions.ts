import type { DatabaseSync } from 'node:sqlite'
import { allocateId } from './ids.ts'
import { tx } from './db.ts'
import { appendEvent } from './events.ts'
import { getTask, listTasks, type Task } from './tasks.ts'
import { UserError } from '../cli/errors.ts'

export type Addressee = 'owner' | 'orchestrator' | 'executor'
export type SubjectType = 'request' | 'task' | 'stage' | 'routine_step'
export type QuestionStatus = 'pending' | 'answered' | 'expired' | 'superseded'
export type TimeoutPolicy = 'block' | 'proceed'

export interface Question {
  id: string
  addressee: Addressee
  text: string
  options: string[]
  subjectType: SubjectType
  subjectId: string
  deadline: string | null
  timeoutPolicy: TimeoutPolicy
  status: QuestionStatus
  answer: string | null
  answeredBy: string | null
  answeredAt: string | null
  createdAt: string
}

interface Row {
  id: string
  addressee: Addressee
  text: string
  options: string | null
  subject_type: SubjectType
  subject_id: string
  deadline: string | null
  timeout_policy: TimeoutPolicy
  status: QuestionStatus
  answer: string | null
  answered_by: string | null
  answered_at: string | null
  created_at: string
}

const toQuestion = (row: Row): Question => ({
  id: row.id,
  addressee: row.addressee,
  text: row.text,
  options: row.options ? (JSON.parse(row.options) as string[]) : [],
  subjectType: row.subject_type,
  subjectId: row.subject_id,
  deadline: row.deadline,
  timeoutPolicy: row.timeout_policy,
  status: row.status,
  answer: row.answer,
  answeredBy: row.answered_by,
  answeredAt: row.answered_at,
  createdAt: row.created_at,
})

export function ask(
  db: DatabaseSync,
  input: {
    addressee: Addressee
    text: string
    options?: string[]
    subjectType: SubjectType
    subjectId: string
    deadline?: string
    timeoutPolicy?: TimeoutPolicy
  },
): Question {
  return tx(db, () => {
    const question: Question = {
      id: allocateId(db, 'question'),
      addressee: input.addressee,
      text: input.text,
      options: input.options ?? [],
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      deadline: input.deadline ?? null,
      timeoutPolicy: input.timeoutPolicy ?? 'block',
      status: 'pending',
      answer: null,
      answeredBy: null,
      answeredAt: null,
      createdAt: new Date().toISOString(),
    }

    db.prepare(
      'insert into questions (id, addressee, text, options, subject_type, subject_id, deadline, timeout_policy, status, answer, answered_by, answered_at, created_at) ' +
        'values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(
      question.id,
      question.addressee,
      question.text,
      question.options.length ? JSON.stringify(question.options) : null,
      question.subjectType,
      question.subjectId,
      question.deadline,
      question.timeoutPolicy,
      question.status,
      null,
      null,
      null,
      question.createdAt,
    )

    appendEvent(db, {
      type: 'question.asked',
      actor: 'system',
      subject: question.id,
      after: { addressee: question.addressee, subjectId: question.subjectId },
    })

    return question
  })
}

export function answer(
  db: DatabaseSync,
  input: { id: string; answer: string; actor: string },
): Question {
  return tx(db, () => {
    const question = getQuestion(db, input.id)
    if (!question) throw new UserError(3, `вопрос ${input.id} не найден`)
    if (question.status !== 'pending') throw new UserError(1, `вопрос ${input.id} уже закрыт: ${question.status}`)
    if (question.addressee !== input.actor && input.actor !== 'orchestrator') {
      throw new UserError(3, `вопрос адресован ${question.addressee}, а отвечает ${input.actor}`)
    }

    db.prepare(
      "update questions set status = 'answered', answer = ?, answered_by = ?, answered_at = ? where id = ?",
    ).run(input.answer, input.actor, new Date().toISOString(), question.id)

    appendEvent(db, {
      type: 'question.answered',
      actor: input.actor,
      subject: question.id,
      after: { answer: input.answer },
    })

    return getQuestion(db, question.id)!
  })
}

export function getQuestion(db: DatabaseSync, id: string): Question | null {
  const row = db.prepare('select * from questions where id = ?').get(id) as Row | undefined
  return row ? toQuestion(row) : null
}

export function getQuestions(
  db: DatabaseSync,
  filter: { addressee?: string; status?: string } = {},
): Question[] {
  const where: string[] = []
  const params: string[] = []

  if (filter.addressee) {
    where.push('addressee = ?')
    params.push(filter.addressee)
  }
  if (filter.status) {
    where.push('status = ?')
    params.push(filter.status)
  }

  const sql =
    'select * from questions' +
    (where.length ? ' where ' + where.join(' and ') : '') +
    ' order by created_at, id'

  return (db.prepare(sql).all(...params) as unknown as Row[]).map(toQuestion)
}

export function expireQuestions(db: DatabaseSync, now = new Date().toISOString()): string[] {
  const rows = db
    .prepare("select * from questions where status = 'pending' and deadline is not null and deadline < ?")
    .all(now) as unknown as Row[]

  for (const row of rows) {
    const question = toQuestion(row)
    const next = question.timeoutPolicy === 'proceed' ? 'answered' : 'expired'
    db.prepare(
      "update questions set status = ?, answer = ?, answered_by = 'timeout', answered_at = ? where id = ?",
    ).run(
      next,
      question.timeoutPolicy === 'proceed' ? 'срок истёк: продолжаем с текущим вариантом' : null,
      now,
      question.id,
    )
    appendEvent(db, {
      type: 'question.expired',
      actor: 'system',
      subject: question.id,
      note: question.timeoutPolicy,
    })
  }

  return rows.map((row) => row.id)
}

export interface OwnerItem {
  id: string
  kind: 'task' | 'question'
  deadline: string | null
  createdAt: string
  item: Task | Question
}

export function ownerHand(db: DatabaseSync): OwnerItem[] {
  const items: OwnerItem[] = []

  for (const task of listTasks(db).filter(
    (task) =>
      (task.holder === 'owner' && task.status === 'active') ||
      task.status === 'needs_owner' ||
      (task.status === 'in_review' && task.review === 'owner'),
  )) {
    items.push({ id: task.id, kind: 'task', deadline: null, createdAt: task.createdAt, item: task })
  }

  for (const question of getQuestions(db, { addressee: 'owner', status: 'pending' })) {
    items.push({
      id: question.id,
      kind: 'question',
      deadline: question.deadline,
      createdAt: question.createdAt,
      item: question,
    })
  }

  return items.sort((a, b) => {
    if (a.deadline === b.deadline) return a.createdAt.localeCompare(b.createdAt)
    if (a.deadline === null) return 1
    if (b.deadline === null) return -1
    return a.deadline.localeCompare(b.deadline)
  })
}

export function inbox(db: DatabaseSync): OwnerItem[] {
  return ownerHand(db)
}

export function taskForQuestion(db: DatabaseSync, question: Question): Task | null {
  return question.subjectType === 'task' ? getTask(db, question.subjectId) : null
}
