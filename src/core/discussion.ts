import type { DatabaseSync } from 'node:sqlite'
import { UserError } from '../cli/errors.ts'
import { getCard } from './cards.ts'
import { nowIso } from './clock.ts'
import { tx } from './db.ts'
import { appendEvent } from './events.ts'

export type DiscussionKind = 'question' | 'answer' | 'comment' | 'assumption'
export type DiscussionStatus = 'open' | 'answered' | 'closed'

/** Обсуждение карточки: вопросы владельцу, ответы, допущения и комментарии. */
export interface Discussion {
  id: number
  cardId: string
  author: string
  kind: DiscussionKind
  text: string
  status: DiscussionStatus
  answerTo: number | null
  createdAt: string
  answeredAt: string | null
}

export interface AskInput {
  cardId: string
  author: string
  text: string
}

export interface AnswerInput {
  cardId: string
  actor: string
  questionId: number
  text: string
}

export interface CommentInput {
  cardId: string
  author: string
  text: string
}

interface Row {
  id: number
  card_id: string
  author: string
  kind: string
  text: string
  status: string
  answer_to: number | null
  created_at: string
  answered_at: string | null
}

const toDiscussion = (row: Row): Discussion => ({
  id: row.id,
  cardId: row.card_id,
  author: row.author,
  kind: row.kind as DiscussionKind,
  text: row.text,
  status: row.status as DiscussionStatus,
  answerTo: row.answer_to,
  createdAt: row.created_at,
  answeredAt: row.answered_at,
})

function requireCard(db: DatabaseSync, cardId: string): void {
  if (!getCard(db, cardId)) throw new UserError(3, `карточка ${cardId} не найдена`)
}

function requiredText(raw: string, message: string): string {
  const value = raw.trim()
  if (!value) throw new UserError(3, message)
  return value
}

function getItem(db: DatabaseSync, id: number): Discussion {
  const row = db.prepare('select * from discussion where id = ?').get(id) as Row
  return toDiscussion(row)
}

/** Вопрос владельцу: `kind=question`, `status=open`. */
export function ask(db: DatabaseSync, input: AskInput): Discussion {
  return tx(db, () => {
    requireCard(db, input.cardId)
    const author = requiredText(input.author, 'нужен автор вопроса')
    const text = requiredText(input.text, 'нужен текст вопроса')

    const result = db
      .prepare(
        'insert into discussion (card_id, author, kind, text, status, answer_to, created_at, answered_at) ' +
          "values (?, ?, 'question', ?, 'open', null, ?, null)",
      )
      .run(input.cardId, author, text, nowIso())

    const question = getItem(db, Number(result.lastInsertRowid))
    appendEvent(db, {
      type: 'discussion.question',
      actor: author,
      subject: input.cardId,
      after: question,
    })
    return question
  })
}

/** Ответ закрывает вопрос и добавляется отдельной строкой со ссылкой `answer_to`. */
export function answer(db: DatabaseSync, input: AnswerInput): Discussion {
  return tx(db, () => {
    requireCard(db, input.cardId)
    const actor = requiredText(input.actor, 'нужен автор ответа')
    const text = requiredText(input.text, 'нужен текст ответа')

    const row = db
      .prepare('select * from discussion where id = ? and card_id = ?')
      .get(input.questionId, input.cardId) as Row | undefined
    if (!row || row.kind !== 'question') {
      throw new UserError(
        3,
        `вопрос ${input.questionId} не найден у карточки ${input.cardId}`,
      )
    }
    if (row.status !== 'open') {
      throw new UserError(3, `вопрос ${input.questionId} уже отвечен`)
    }

    const at = nowIso()
    db.prepare("update discussion set status = 'answered', answered_at = ? where id = ?")
      .run(at, row.id)

    const result = db
      .prepare(
        'insert into discussion (card_id, author, kind, text, status, answer_to, created_at, answered_at) ' +
          "values (?, ?, 'answer', ?, 'closed', ?, ?, ?)",
      )
      .run(input.cardId, actor, text, row.id, at, at)

    const reply = getItem(db, Number(result.lastInsertRowid))
    appendEvent(db, {
      type: 'discussion.answer',
      actor,
      subject: input.cardId,
      after: reply,
    })
    return reply
  })
}

/** Комментарий в обсуждение карточки: не вопрос, ответа не ждёт. */
export function comment(db: DatabaseSync, input: CommentInput): Discussion {
  return tx(db, () => {
    requireCard(db, input.cardId)
    const author = requiredText(input.author, 'нужен автор комментария')
    const text = requiredText(input.text, 'нужен текст комментария')

    const result = db
      .prepare(
        'insert into discussion (card_id, author, kind, text, status, answer_to, created_at, answered_at) ' +
          "values (?, ?, 'comment', ?, 'closed', null, ?, null)",
      )
      .run(input.cardId, author, text, nowIso())

    const item = getItem(db, Number(result.lastInsertRowid))
    appendEvent(db, {
      type: 'discussion.comment',
      actor: author,
      subject: input.cardId,
      after: item,
    })
    return item
  })
}

/** Хронологический порядок: `created_at`, при равном времени — номер строки. */
export function listDiscussion(db: DatabaseSync, cardId: string): Discussion[] {
  const rows = db
    .prepare('select * from discussion where card_id = ? order by created_at, id')
    .all(cardId) as unknown as Row[]
  return rows.map(toDiscussion)
}

export function openQuestions(db: DatabaseSync, cardId?: string): Discussion[] {
  const sql =
    "select * from discussion where kind = 'question' and status = 'open'" +
    (cardId === undefined ? '' : ' and card_id = ?') +
    ' order by created_at, id'
  const rows = (
    cardId === undefined ? db.prepare(sql).all() : db.prepare(sql).all(cardId)
  ) as unknown as Row[]
  return rows.map(toDiscussion)
}
