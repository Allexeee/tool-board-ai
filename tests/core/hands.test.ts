import test from 'node:test'
import assert from 'node:assert/strict'
import { openDb, type DatabaseSync } from '../../src/core/db.ts'
import { addRequest } from '../../src/core/requests.ts'
import { abandonFeature, addFeature, setFeatureBranch } from '../../src/core/features.ts'
import { addStage, activateNextStage } from '../../src/core/stages.ts'
import { createTask, updateTask } from '../../src/core/tasks.ts'
import { refreshReady, addDep } from '../../src/core/deps.ts'
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
  setFeatureBranch(db, feature.id, 'feat/test', 'C:/tmp/test-worktree')
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

test('чужой резерв не мешает взять задачу', () => {
  const db = openDb(':memory:')
  const stageId = seed(db)
  fillHand(db, 'w1')

  const task = takeTask(db, { executor: 'w2', taskId: `${stageId}-1` })

  assert.equal(task.holder, 'w2')
  assert.deepEqual(
    getHand(db, 'w2').map((item) => item.id).includes(`${stageId}-1`),
    false,
    'резерв снят при взятии',
  )
})

test('take без id берёт одну задачу и не запасает руку', () => {
  const db = openDb(':memory:')
  const stageId = seed(db)

  const task = takeTask(db, { executor: 'w1' })

  assert.equal(task.id, `${stageId}-1`)
  assert.deepEqual(getHand(db, 'w1'), [])
  const ready = db
    .prepare("select count(*) as c from tasks where stage_id = ? and status = 'ready'")
    .get(stageId) as { c: number }
  assert.equal(ready.c, 2, 'остальные задачи остаются свободными')
})

test('take без id уважает порядок своей руки', () => {
  const db = openDb(':memory:')
  const stageId = seed(db)
  setHand(db, 'w1', [`${stageId}-3`, `${stageId}-2`], 'owner')

  const task = takeTask(db, { executor: 'w1' })

  assert.equal(task.id, `${stageId}-3`)
  assert.deepEqual(
    getHand(db, 'w1').map((item) => item.id),
    [`${stageId}-2`],
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

test('setHand не падает, если задача в списке повторяется', () => {
  const db = openDb(':memory:')
  const stageId = seed(db)
  const hand = setHand(db, 'w1', [`${stageId}-1`, `${stageId}-1`], 'orchestrator')
  assert.deepEqual(hand.map((task) => task.id), [`${stageId}-1`])
})

test('setHand принимает шаг, чья зависимость уже лежит в руке', () => {
  const db = openDb(':memory:')
  const stageId = seed(db)
  addDep(db, `${stageId}-2`, `${stageId}-1`)
  refreshReady(db)

  const hand = setHand(db, 'w1', [`${stageId}-1`, `${stageId}-2`], 'owner')

  assert.deepEqual(hand.map((task) => task.id), [`${stageId}-1`, `${stageId}-2`])
  assert.equal(hand[1].status, 'open', 'следующий шаг виден в руке до своей готовности')
})

test('setHand принимает шаг с уже закрытой зависимостью', () => {
  const db = openDb(':memory:')
  const stageId = seed(db)
  addDep(db, `${stageId}-2`, `${stageId}-1`)
  db.prepare("update tasks set status = 'done' where id = ?").run(`${stageId}-1`)
  refreshReady(db)

  const hand = setHand(db, 'w1', [`${stageId}-2`], 'owner')

  assert.deepEqual(hand.map((task) => task.id), [`${stageId}-2`])
})

test('setHand отказывает, если зависимость не закрыта и её нет в руке', () => {
  const db = openDb(':memory:')
  const stageId = seed(db)
  addDep(db, `${stageId}-2`, `${stageId}-1`)
  refreshReady(db)

  assert.throws(
    () => setHand(db, 'w1', [`${stageId}-2`], 'owner'),
    (error: Error) => error.message.includes('ждёт зависимость') && error.message.includes(`${stageId}-1`),
    'в тексте отказа названа мешающая зависимость',
  )
})

test('setHand обрезает цепочку по размеру руки', () => {
  const db = openDb(':memory:')
  const stageId = seed(db)
  addExecutor(db, { id: 'w3', kind: 'agent', skills: ['backend'], handSize: 2 })

  const hand = setHand(db, 'w3', [`${stageId}-1`, `${stageId}-2`, `${stageId}-3`], 'owner')

  assert.deepEqual(hand.map((task) => task.id), [`${stageId}-1`, `${stageId}-2`])
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

test('задача, ушедшая из ready, исчезает из руки', () => {
  const db = openDb(':memory:')
  const stageId = seed(db)
  fillHand(db, 'w1')
  assert.ok(getHand(db, 'w1').length > 0)

  updateTask(db, `${stageId}-1`, { status: 'blocked', reason: 'needs_data' })

  assert.equal(getHand(db, 'w1').some((task) => task.id === `${stageId}-1`), false)
})

test('abandon фичи чистит руку', () => {
  const db = openDb(':memory:')
  seed(db)
  fillHand(db, 'w1')
  assert.ok(getHand(db, 'w1').length > 0)

  const feature = db.prepare('select id from features').get() as { id: string }
  abandonFeature(db, { featureId: feature.id, actor: 'owner', reason: 'передумали' })

  assert.deepEqual(getHand(db, 'w1'), [])
})



