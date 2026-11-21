import test from 'node:test'
import assert from 'node:assert/strict'
import { createCard, editCard, getCard, listCards } from '../../src/core/cards.ts'
import { listEvents } from '../../src/core/events.ts'
import { makeBoard, seedCard } from '../helpers/board.ts'

test('createCard выдаёт ID группы и заводит запрос', (t) => {
  const { db, close } = makeBoard()
  t.after(close)

  const first = createCard(db, {
    group: 'UI',
    title: 'Форма входа',
    skill: 'dev',
    author: 'owner',
  })
  const second = createCard(db, {
    group: 'UI',
    title: 'Валидация',
    skill: 'dev',
    author: 'owner',
  })

  assert.equal(first.id, 'UI-1')
  assert.equal(second.id, 'UI-2')
  assert.equal(first.group, 'UI')
  assert.equal(first.groupSeq, 1)
  assert.equal(first.phase, 'request')
  assert.equal(first.status, 'new')
  assert.equal(first.skill, 'dev')
  assert.equal(first.body, '')
  assert.deepEqual(first.scope, [])
  assert.equal(first.needsMerge, true)
  assert.equal(first.reviewRequired, false)
  assert.equal(first.importance, null)
  assert.equal(first.urgency, null)
  assert.equal(first.position, null)
  assert.equal(first.attempt, 1)
})

test('карточка с навыком owner сразу задача в ready', (t) => {
  const { db, close } = makeBoard()
  t.after(close)

  const owner = seedCard(db, { group: 'OPS', title: 'Создать VK группу', skill: 'owner' })

  assert.equal(owner.id, 'OPS-1')
  assert.equal(owner.phase, 'task')
  assert.equal(owner.status, 'ready')
  assert.equal(owner.needsMerge, false)
  assert.equal(owner.reviewRequired, false)
})

test('создание карточки пишет автора в журнал', (t) => {
  const { db, close } = makeBoard()
  t.after(close)

  const card = createCard(db, {
    group: 'UI',
    title: 'Форма входа',
    skill: 'dev',
    author: 'developer',
  })

  const events = listEvents(db, card.id)
  assert.equal(events.length, 1)
  assert.equal(events[0].type, 'card.created')
  assert.equal(events[0].actor, 'developer')
})

test('createCard проверяет группу, заголовок и навык', (t) => {
  const { db, close } = makeBoard()
  t.after(close)

  assert.throws(
    () => createCard(db, { group: 'ui/tool', title: 'x', skill: 'dev', author: 'owner' }),
    /префикс/,
  )
  assert.throws(
    () => createCard(db, { group: 'UI', title: '  ', skill: 'dev', author: 'owner' }),
    /заголовок/,
  )
  assert.throws(
    () => createCard(db, { group: 'UI', title: 'x', skill: '  ', author: 'owner' }),
    /навык/,
  )
  assert.throws(
    () => createCard(db, { group: 'UI', title: 'x', skill: 'dev', author: '  ' }),
    /автор/,
  )
})

test('editCard меняет поля запроса до submit', (t) => {
  const { db, close } = makeBoard()
  t.after(close)

  const card = createCard(db, {
    group: 'UI',
    title: 'Форма входа',
    skill: 'dev',
    author: 'owner',
  })

  const edited = editCard(db, {
    id: card.id,
    actor: 'developer',
    patch: {
      title: 'Форма регистрации',
      body: 'Что хочу и зачем',
      skill: 'marketer',
      importance: 3,
      urgency: 0,
      needsMerge: false,
      reviewRequired: true,
      scope: ['src/**', 'tests/**'],
      note: 'разобрал',
    },
  })

  assert.equal(edited.title, 'Форма регистрации')
  assert.equal(edited.body, 'Что хочу и зачем')
  assert.equal(edited.skill, 'marketer')
  assert.equal(edited.importance, 3)
  assert.equal(edited.urgency, 0)
  assert.equal(edited.needsMerge, false)
  assert.equal(edited.reviewRequired, true)
  assert.deepEqual(edited.scope, ['src/**', 'tests/**'])
  assert.equal(edited.note, 'разобрал')
  assert.equal(edited.phase, 'request')
  assert.equal(edited.status, 'new')

  assert.deepEqual(
    listEvents(db, card.id).map((event) => event.type),
    ['card.created', 'card.edited'],
  )
  assert.equal(listEvents(db, card.id)[1].actor, 'developer')
})

test('spec и acceptance сохраняются, specRev растёт при правке', (t) => {
  const { db, close } = makeBoard()
  t.after(close)

  const card = createCard(db, {
    group: 'UI',
    title: 'Форма',
    body: 'spec',
    skill: 'dev',
    author: 'owner',
  })
  assert.equal(card.acceptance, '')
  assert.equal(card.specRev, 1)

  const withAcceptance = editCard(db, {
    id: card.id,
    actor: 'developer',
    patch: { acceptance: ['первый', 'второй'] },
  })
  assert.equal(withAcceptance.acceptance, 'первый\nвторой')
  assert.equal(withAcceptance.specRev, 2)

  const withScope = editCard(db, {
    id: card.id,
    actor: 'developer',
    patch: { scope: ['src/**'] },
  })
  assert.equal(withScope.specRev, 3)
})

test('после submit навык неизменяем, остальные поля меняются', (t) => {
  const { db, close } = makeBoard()
  t.after(close)

  const card = createCard(db, {
    group: 'UI',
    title: 'Форма входа',
    skill: 'dev',
    author: 'owner',
  })
  db.prepare("update cards set status = 'approval' where id = ?").run(card.id)

  const edited = editCard(db, {
    id: card.id,
    actor: 'owner',
    patch: { title: 'Форма', importance: 2, body: 'уточнил' },
  })
  assert.equal(edited.title, 'Форма')
  assert.equal(edited.importance, 2)

  assert.throws(
    () => editCard(db, { id: card.id, actor: 'owner', patch: { skill: 'marketer' } }),
    /навык/,
  )
  // тот же навык — не изменение
  assert.equal(
    editCard(db, { id: card.id, actor: 'owner', patch: { skill: 'dev' } }).skill,
    'dev',
  )
})

test('навык меняется, пока карточка shaping', (t) => {
  const { db, close } = makeBoard()
  t.after(close)

  const card = createCard(db, {
    group: 'UI',
    title: 'Форма входа',
    skill: 'dev',
    author: 'owner',
  })
  db.prepare("update cards set status = 'shaping' where id = ?").run(card.id)

  const edited = editCard(db, { id: card.id, actor: 'developer', patch: { skill: 'marketer' } })
  assert.equal(edited.skill, 'marketer')
})

test('оценки важности и срочности — целые от 0 до 3', (t) => {
  const { db, close } = makeBoard()
  t.after(close)

  const card = createCard(db, {
    group: 'UI',
    title: 'Форма входа',
    skill: 'dev',
    author: 'owner',
  })

  assert.throws(
    () => editCard(db, { id: card.id, actor: 'owner', patch: { importance: 4 } }),
    /важность/,
  )
  assert.throws(
    () => editCard(db, { id: card.id, actor: 'owner', patch: { urgency: -1 } }),
    /срочность/,
  )
  assert.throws(
    () => editCard(db, { id: card.id, actor: 'owner', patch: { importance: 1.5 } }),
    /важность/,
  )
  assert.throws(
    () => editCard(db, { id: card.id, actor: 'owner', patch: { urgency: Number.NaN } }),
    /срочность/,
  )
})

test('owner-карточка не мержится и не меняет навык', (t) => {
  const { db, close } = makeBoard()
  t.after(close)

  const card = createCard(db, {
    group: 'OPS',
    title: 'Создать VK группу',
    skill: 'owner',
    author: 'owner',
  })

  assert.throws(
    () => editCard(db, { id: card.id, actor: 'owner', patch: { needsMerge: true } }),
    /owner|мерж/,
  )
  assert.throws(
    () => editCard(db, { id: card.id, actor: 'owner', patch: { skill: 'dev' } }),
    /навык/,
  )

  const edited = editCard(db, {
    id: card.id,
    actor: 'owner',
    patch: { title: 'Создать сообщество', note: 'руками' },
  })
  assert.equal(edited.title, 'Создать сообщество')
  assert.equal(edited.note, 'руками')
  assert.equal(edited.needsMerge, false)
})

test('навык owner несовместим с needs_merge=true', (t) => {
  const { db, close } = makeBoard()
  t.after(close)

  const card = createCard(db, {
    group: 'UI',
    title: 'Создать VK группу',
    skill: 'dev',
    author: 'owner',
  })

  assert.throws(
    () => editCard(db, { id: card.id, actor: 'owner', patch: { skill: 'owner' } }),
    /owner|мерж/,
  )

  const edited = editCard(db, {
    id: card.id,
    actor: 'owner',
    patch: { skill: 'owner', needsMerge: false },
  })
  assert.equal(edited.skill, 'owner')
  assert.equal(edited.needsMerge, false)
  // до approval это ещё запрос: owner-правила включаются после утверждения
  assert.equal(edited.phase, 'request')
  assert.equal(edited.status, 'new')
})

test('listCards фильтрует по фазе, статусу, навыку, держателю и группе', (t) => {
  const { db, close } = makeBoard()
  t.after(close)

  const first = createCard(db, { group: 'UI', title: 'a', skill: 'dev', author: 'owner' })
  const second = createCard(db, {
    group: 'UI',
    title: 'b',
    skill: 'marketing',
    author: 'owner',
  })
  const third = createCard(db, { group: 'IM', title: 'c', skill: 'dev', author: 'owner' })
  const owner = createCard(db, { group: 'OPS', title: 'd', skill: 'owner', author: 'owner' })
  db.prepare('update cards set holder = ? where id = ?').run('developer', first.id)

  const ids = (cards: { id: string }[]) => cards.map((card) => card.id)

  assert.deepEqual(ids(listCards(db)), [first.id, second.id, third.id, owner.id])
  assert.deepEqual(ids(listCards(db, { phase: 'request' })), [first.id, second.id, third.id])
  assert.deepEqual(ids(listCards(db, { phase: 'task' })), [owner.id])
  assert.deepEqual(ids(listCards(db, { status: 'new' })), [first.id, second.id, third.id])
  assert.deepEqual(ids(listCards(db, { status: 'ready' })), [owner.id])
  assert.deepEqual(ids(listCards(db, { status: ['new', 'ready'] })), [
    first.id,
    second.id,
    third.id,
    owner.id,
  ])
  assert.deepEqual(ids(listCards(db, { skill: 'dev' })), [first.id, third.id])
  assert.deepEqual(ids(listCards(db, { holder: 'developer' })), [first.id])
  assert.deepEqual(ids(listCards(db, { group: 'ui' })), [first.id, second.id])
  assert.deepEqual(ids(listCards(db, { group: 'NOPE' })), [])
})

test('getCard возвращает null, editCard на неизвестной карточке отказывает', (t) => {
  const { db, close } = makeBoard()
  t.after(close)

  assert.equal(getCard(db, 'UI-9'), null)
  assert.throws(
    () => editCard(db, { id: 'UI-9', actor: 'owner', patch: { title: 'x' } }),
    /не найдена/,
  )
})
