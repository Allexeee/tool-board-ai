import test from 'node:test'
import assert from 'node:assert/strict'
import { createCard } from '../../src/core/cards.ts'
import { answer, ask, listDiscussion, openQuestions } from '../../src/core/discussion.ts'
import { listEvents } from '../../src/core/events.ts'
import { makeBoard } from '../helpers/board.ts'

function makeCardBoard(t: { after: (fn: () => void) => void }) {
  const board = makeBoard()
  t.after(board.close)
  const card = createCard(board.db, {
    group: 'UI',
    title: 'x',
    skill: 'dev',
    author: 'owner',
  })
  return { db: board.db, card }
}

test('ask заводит открытый вопрос', (t) => {
  const { db, card } = makeCardBoard(t)

  const question = ask(db, {
    cardId: card.id,
    author: 'developer',
    text: '  Нужен ли SSO?  ',
  })

  assert.equal(typeof question.id, 'number')
  assert.equal(question.cardId, card.id)
  assert.equal(question.author, 'developer')
  assert.equal(question.kind, 'question')
  assert.equal(question.text, 'Нужен ли SSO?')
  assert.equal(question.status, 'open')
  assert.equal(question.answerTo, null)
  assert.equal(question.answeredAt, null)
  assert.match(question.createdAt, /^\d{4}-\d{2}-\d{2}T/)
  assert.deepEqual(
    openQuestions(db, card.id).map((item) => item.id),
    [question.id],
  )
})

test('answer закрывает вопрос и добавляет ответ', (t) => {
  const { db, card } = makeCardBoard(t)
  const question = ask(db, { cardId: card.id, author: 'developer', text: 'Нужен ли SSO?' })

  const reply = answer(db, {
    cardId: card.id,
    actor: 'owner',
    questionId: question.id,
    text: 'Нет',
  })

  assert.equal(reply.kind, 'answer')
  assert.equal(reply.author, 'owner')
  assert.equal(reply.text, 'Нет')
  assert.equal(reply.answerTo, question.id)
  assert.match(reply.answeredAt ?? '', /^\d{4}-\d{2}-\d{2}T/)

  const [closed] = listDiscussion(db, card.id)
  assert.equal(closed.status, 'answered')
  assert.match(closed.answeredAt ?? '', /^\d{4}-\d{2}-\d{2}T/)
  assert.equal(openQuestions(db, card.id).length, 0)
})

test('openQuestions без карточки собирает вопросы по всей доске', (t) => {
  const { db, card } = makeCardBoard(t)
  const other = createCard(db, { group: 'UI', title: 'y', skill: 'dev', author: 'owner' })
  ask(db, { cardId: card.id, author: 'developer', text: 'Первый?' })
  const second = ask(db, { cardId: other.id, author: 'marketer', text: 'Второй?' })
  const answered = ask(db, { cardId: other.id, author: 'marketer', text: 'Третий?' })
  answer(db, { cardId: other.id, actor: 'owner', questionId: answered.id, text: 'Да' })

  const open = openQuestions(db)
  assert.equal(open.length, 2)
  assert.deepEqual(
    open.map((item) => item.text),
    ['Первый?', 'Второй?'],
  )
  assert.equal(open[1]!.id, second.id)
})

test('listDiscussion идёт в хронологическом порядке', (t) => {
  const { db, card } = makeCardBoard(t)
  const first = ask(db, { cardId: card.id, author: 'developer', text: 'Первый?' })
  const reply = answer(db, { cardId: card.id, actor: 'owner', questionId: first.id, text: 'Да' })
  const second = ask(db, { cardId: card.id, author: 'developer', text: 'Второй?' })

  assert.deepEqual(
    listDiscussion(db, card.id).map((item) => item.id),
    [first.id, reply.id, second.id],
  )
})

test('ask и answer пишут события в журнал', (t) => {
  const { db, card } = makeCardBoard(t)
  const question = ask(db, { cardId: card.id, author: 'developer', text: 'Нужен ли SSO?' })
  answer(db, { cardId: card.id, actor: 'owner', questionId: question.id, text: 'Нет' })

  const events = listEvents(db, card.id)
  assert.deepEqual(
    events.map((event) => event.type),
    ['card.created', 'discussion.question', 'discussion.answer'],
  )
  assert.equal(events[1]!.actor, 'developer')
  assert.equal(events[2]!.actor, 'owner')
})

test('answer требует открытый вопрос этой карточки', (t) => {
  const { db, card } = makeCardBoard(t)
  const other = createCard(db, { group: 'UI', title: 'y', skill: 'dev', author: 'owner' })
  const question = ask(db, { cardId: card.id, author: 'developer', text: 'Нужен ли SSO?' })

  assert.throws(
    () => answer(db, { cardId: other.id, actor: 'owner', questionId: question.id, text: 'Нет' }),
    /не найден/,
  )
  assert.throws(
    () => answer(db, { cardId: card.id, actor: 'owner', questionId: 42, text: 'Нет' }),
    /не найден/,
  )
  answer(db, { cardId: card.id, actor: 'owner', questionId: question.id, text: 'Нет' })
  assert.throws(
    () => answer(db, { cardId: card.id, actor: 'owner', questionId: question.id, text: 'Ещё' }),
    /уже отвечен/,
  )
})

test('ask и answer проверяют текст и карточку', (t) => {
  const { db, card } = makeCardBoard(t)
  const question = ask(db, { cardId: card.id, author: 'developer', text: 'Нужен ли SSO?' })

  assert.throws(() => ask(db, { cardId: card.id, author: 'developer', text: '  ' }), /текст/)
  assert.throws(() => ask(db, { cardId: 'UI-9', author: 'developer', text: 'x' }), /не найдена/)
  assert.throws(
    () => answer(db, { cardId: card.id, actor: 'owner', questionId: question.id, text: '  ' }),
    /текст/,
  )
})
