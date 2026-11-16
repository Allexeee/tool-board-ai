import test from 'node:test'
import assert from 'node:assert/strict'
import { openDb, type DatabaseSync } from '../../src/core/db.ts'
import { addRequest } from '../../src/core/requests.ts'
import { addFeature } from '../../src/core/features.ts'
import { addStage, activateNextStage } from '../../src/core/stages.ts'
import { createTask } from '../../src/core/tasks.ts'
import { refreshReady } from '../../src/core/deps.ts'
import { advanceTime } from '../../src/core/clock.ts'
import { takeTask } from '../../src/core/lease.ts'
import { addExecutor } from '../../src/core/executors.ts'
import { compareTasks, fillHand, getHand, setHand } from '../../src/core/hands.ts'

const plusMinutes = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString()

function seed(db: DatabaseSync): string {
  addExecutor(db, { id: 'w1', kind: 'agent', skills: ['backend'] })
  addExecutor(db, { id: 'w2', kind: 'agent', skills: ['backend'] })

  const request = addRequest(db, { title: 'Оплата', body: '...', author: 'owner' })
  const feature = addFeature(db, { requestId: request.id, name: 'A', rank: 1 })
  const stage = addStage(db, { featureId: feature.id, name: 'S1', goal: 'g', appetite: '2 дня' })
  activateNextStage(db, feature.id)

  const base = {
    stageId: stage.id,
    dod: ['a'],
    size: 'S' as const,
    skill: 'backend',
    class: 'standard' as const,
    scope: ['src/**'],
  }
  createTask(db, { ...base, title: 'Первый шаг' })
  createTask(db, { ...base, title: 'Второй шаг' })
  createTask(db, { ...base, title: 'Третий шаг' })
  refreshReady(db)
  return stage.id
}

test('рука пополняется задачами того же этапа первыми', () => {
  const db = openDb(':memory:')
  const stageId = seed(db)
  const hand = fillHand(db, 'w1')
  assert.equal(hand[0].id, `${stageId}-1`)
})

test('все кандидаты заблокированы — рука пуста, без зависания', () => {
  const db = openDb(':memory:')
  seed(db)
  db.prepare("update tasks set status='blocked'").run()
  assert.deepEqual(fillHand(db, 'w1'), [])
})

test('порядок: expedite раньше standard, XS раньше M', () => {
  const make = (over: Record<string, unknown>) => ({ id: 'x', class: 'standard', size: 'S', ...over }) as never
  assert.ok(compareTasks(make({ class: 'expedite', size: 'M' }), make({ size: 'XS' })) < 0)
  assert.ok(compareTasks(make({ size: 'XS' }), make({ size: 'M' })) < 0)
})

test('задача с чужим навыком не попадает в руку', () => {
  const db = openDb(':memory:')
  const stageId = seed(db)
  createTask(db, {
    stageId,
    title: 'Записать выстрелы',
    dod: ['a'],
    size: 'S',
    skill: 'audio',
    class: 'standard',
    scope: ['assets/**'],
  })
  refreshReady(db)
  assert.equal(fillHand(db, 'w1').some((task) => task.skill === 'audio'), false)
})

test('зарезервированную задачу не берёт другой исполнитель', () => {
  const db = openDb(':memory:')
  const stageId = seed(db)
  fillHand(db, 'w1')
  assert.throws(
    () => takeTask(db, { executor: 'w2', taskId: `${stageId}-1` }),
    (error: { code?: number }) => error.code === 1,
  )
})

test('исполнитель offline теряет руку', () => {
  const db = openDb(':memory:')
  seed(db)
  fillHand(db, 'w2')
  assert.ok(getHand(db, 'w2').length > 0)
  advanceTime(db, plusMinutes(121))
  assert.deepEqual(getHand(db, 'w2'), [])
})

test('setHand не отбирает задачу, зарезервированную другим', () => {
  const db = openDb(':memory:')
  const stageId = seed(db)
  fillHand(db, 'w1')
  assert.throws(() => setHand(db, 'w2', [`${stageId}-1`], 'orchestrator'), /зарезервирован/)
})

test('пул набирается после блока фичи', () => {
  const db = openDb(':memory:')
  const stageId = seed(db)

  createTask(db, {
    title: 'Поправить опечатку',
    dod: ['опечатки нет'],
    size: 'XS',
    skill: 'backend',
    class: 'quick',
    scope: ['docs/**'],
  })
  refreshReady(db)

  const hand = fillHand(db, 'w1')
  assert.equal(hand[0].id, `${stageId}-1`)
  assert.ok(hand.some((task) => task.id === 'T1'), 'задача пула попала в руку')
  assert.equal(hand[hand.length - 1].id, 'T1')
})
