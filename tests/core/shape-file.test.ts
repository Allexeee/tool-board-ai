import test from 'node:test'
import assert from 'node:assert/strict'
import { getCard } from '../../src/core/cards.ts'
import { listDeps } from '../../src/core/deps.ts'
import { listRefs } from '../../src/core/refs.ts'
import { listSteps } from '../../src/core/steps.ts'
import { applyShapeFile, shapeCard } from '../../src/core/lifecycle.ts'
import { makeBoard, seedCard } from '../helpers/board.ts'

type Board = ReturnType<typeof makeBoard>

function board(t: { after: (fn: () => void) => void }): Board {
  const fixture = makeBoard()
  t.after(fixture.close)
  return fixture
}

const planJson = {
  body: 'Форма входа с валидацией',
  skill: 'dev',
  importance: 3,
  urgency: 2,
  needs_merge: true,
  review_required: true,
  scope: ['src/**', 'tests/**'],
  steps: ['Написать форму', 'Добавить тест'],
  refs: [{ kind: 'spec', value: 'docs/specs/login.md' }],
  deps: [] as string[],
  new_cards: [
    {
      key: 'gen',
      group: 'UI',
      title: 'Генератор форм',
      skill: 'dev',
      body: 'отдельный запрос',
      needs_merge: true,
    },
  ],
  new_deps: [['UI-1', 'gen']],
}

test('applyShapeFile применяет поля, шаги, ссылки и создаёт новые карточки', (t) => {
  const { db } = board(t)
  const card = seedCard(db)
  shapeCard(db, { id: card.id, actor: 'developer' })

  const result = applyShapeFile(db, { id: card.id, actor: 'developer', file: planJson })

  const shaped = getCard(db, card.id)!
  assert.equal(shaped.importance, 3)
  assert.equal(shaped.urgency, 2)
  assert.equal(shaped.needsMerge, true)
  assert.equal(shaped.reviewRequired, true)
  assert.deepEqual(shaped.scope, ['src/**', 'tests/**'])
  assert.equal(shaped.body, 'Форма входа с валидацией')

  assert.equal(listSteps(db, card.id).length, 2)
  assert.equal(listRefs(db, card.id).length, 1)

  assert.equal(result.newCards.length, 1)
  assert.equal(getCard(db, result.newCards[0].id)!.phase, 'request')
  assert.equal(getCard(db, result.newCards[0].id)!.status, 'new')
  assert.equal(getCard(db, result.newCards[0].id)!.title, 'Генератор форм')

  // new_deps [['UI-1', 'gen']] разрешается в зависимость card → новая карточка
  assert.deepEqual(listDeps(db, card.id), [result.newCards[0].id])
})

test('applyShapeFile резолвит deps по ID существующих карточек', (t) => {
  const { db } = board(t)
  const blocker = seedCard(db, { phase: 'task', status: 'done' })
  const card = seedCard(db)
  shapeCard(db, { id: card.id, actor: 'developer' })

  applyShapeFile(db, {
    id: card.id,
    actor: 'developer',
    file: { deps: [blocker.id] },
  })

  assert.deepEqual(listDeps(db, card.id), [blocker.id])
})

test('applyShapeFile атомарен: ошибка не оставляет частичных правок', (t) => {
  const { db } = board(t)
  const card = seedCard(db)
  shapeCard(db, { id: card.id, actor: 'developer' })

  const before = getCard(db, card.id)!

  assert.throws(
    () =>
      applyShapeFile(db, {
        id: card.id,
        actor: 'developer',
        file: {
          importance: 3,
          new_cards: [{ key: 'gen', title: 'без группы', skill: 'dev' }],
        },
      }),
    /групп/,
  )

  const after = getCard(db, card.id)!
  assert.equal(after.importance, before.importance)
  assert.equal(listSteps(db, card.id).length, 0)
  assert.equal(listRefs(db, card.id).length, 0)
  assert.deepEqual(listDeps(db, card.id), [])
})

test('applyShapeFile требует карточку в разборе у держателя', (t) => {
  const { db } = board(t)
  const card = seedCard(db)

  assert.throws(() => applyShapeFile(db, { id: card.id, actor: 'developer', file: {} }), /shaping/)

  shapeCard(db, { id: card.id, actor: 'developer' })
  assert.throws(
    () => applyShapeFile(db, { id: card.id, actor: 'stranger', file: {} }),
    /держатель/,
  )
})
