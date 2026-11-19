import test from 'node:test'
import assert from 'node:assert/strict'
import type { DatabaseSync } from 'node:sqlite'
import { nowIso } from '../../src/core/clock.ts'
import { ask } from '../../src/core/discussion.ts'
import { nowData } from '../../src/core/now.ts'
import { makeBoard, seedCard, seedExecutor, seedRun } from '../helpers/board.ts'

type Board = ReturnType<typeof makeBoard>

function board(t: { after: (fn: () => void) => void }): Board {
  const fixture = makeBoard()
  t.after(fixture.close)
  return fixture
}

/** Время на N суток назад — гарантированно «не сегодня» для счётчика. */
function daysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString()
}

/** Задача в очереди с позицией: верхняя доступная карточка исполнителя. */
function readyCard(
  db: DatabaseSync,
  input: { position: number; skill?: string; group?: string },
) {
  return seedCard(db, {
    phase: 'task',
    status: 'ready',
    position: input.position,
    skill: input.skill ?? 'dev',
    group: input.group ?? 'UI',
    importance: 3,
    urgency: 3,
  })
}

test('now 3: заголовок — сделано сегодня, dev опережает main, последние 5', (t) => {
  const { db, root } = board(t)

  // 2 сделано сегодня
  seedCard(db, { phase: 'task', status: 'done', doneAt: nowIso(), title: 'Сегодня 1' })
  seedCard(db, { phase: 'task', status: 'done', doneAt: nowIso(), title: 'Сегодня 2' })
  // 3 сделано раньше
  seedCard(db, { phase: 'task', status: 'done', doneAt: daysAgo(1), title: 'Вчера' })
  seedCard(db, { phase: 'task', status: 'done', doneAt: daysAgo(2), title: 'Позавчера' })
  seedCard(db, { phase: 'task', status: 'done', doneAt: daysAgo(3), title: 'Ещё раньше' })
  // 1 карточка в dev, не в main
  seedCard(db, { phase: 'task', status: 'review', inDev: true })

  const data = nowData(db, { view: 3, executorId: 'owner', root })

  assert.equal(data.header.doneToday, 2)
  assert.equal(data.header.devAhead, 1)
  assert.equal(data.header.lastDone.length, 5)
  // последние по done_at: два сегодняшних идут первыми
  assert.equal(data.header.lastDone[0].title, 'Сегодня 2')
  assert.equal(data.header.lastDone[1].title, 'Сегодня 1')
  assert.equal(data.header.lastDone[4].title, 'Ещё раньше')
})

test('now 3: «сегодня» — локальные сутки, а не UTC', (t) => {
  const { db, root } = board(t)

  // локальная полночь текущих суток
  const midnight = new Date()
  midnight.setHours(0, 0, 0, 0)

  // за минуту до локальной полуночи — вчера, за минуту после — сегодня
  const before = new Date(midnight.getTime() - 60_000)
  const after = new Date(midnight.getTime() + 60_000)

  seedCard(db, { phase: 'task', status: 'done', doneAt: before.toISOString(), title: 'Вчера' })
  seedCard(db, { phase: 'task', status: 'done', doneAt: after.toISOString(), title: 'Сегодня' })

  const data = nowData(db, { view: 3, executorId: 'owner', root })
  assert.equal(data.header.doneToday, 1)
  assert.equal(data.header.lastDone[0].title, 'Сегодня')
  assert.equal(data.header.lastDone[1].title, 'Вчера')
})

test('now 3: devAhead считает только needs_merge в dev, не в main и без revert', (t) => {
  const { db, root } = board(t)

  seedCard(db, { phase: 'task', status: 'review', inDev: true }) // в dev
  seedCard(db, { phase: 'task', status: 'review', inDev: true, inMain: true }) // уже в main
  seedCard(db, { phase: 'task', status: 'review', inDev: true, revertedAt: daysAgo(1) }) // отменена
  seedCard(db, { phase: 'task', status: 'review', inDev: true, needsMerge: false }) // без мержа

  const data = nowData(db, { view: 3, executorId: 'owner', root })
  assert.equal(data.header.devAhead, 1)
})

test('now 3: очередь — 15 строк и счётчик «ещё»', (t) => {
  const { db, root } = board(t)

  for (let i = 1; i <= 17; i++) readyCard(db, { position: i })

  const data = nowData(db, { view: 3, executorId: 'owner', root })
  assert.equal(data.queue!.length, 15)
  assert.equal(data.moreQueue, 2)
  assert.equal(data.queue![0].position, 1)
  assert.equal(data.queue![14].position, 15)
})

test('now 3: запросы — до 10 по времени создания и счётчик «ещё»', (t) => {
  const { db, root } = board(t)

  for (let i = 0; i < 12; i++) {
    seedCard(db, { phase: 'request', status: 'new', title: `Запрос ${i}` })
  }

  const data = nowData(db, { view: 3, executorId: 'owner', root })
  assert.equal(data.requests!.length, 10)
  assert.equal(data.moreRequests, 2)
  assert.ok(data.requests!.every((card) => card.phase === 'request'))
  // порядок — по created_at
  assert.equal(data.requests![0].title, 'Запрос 0')
  assert.equal(data.requests![9].title, 'Запрос 9')
})

test('now 3: фильтры по группе, статусу, навыку и «моё»', (t) => {
  const { db, root } = board(t)
  seedExecutor(db, { id: 'developer', skills: ['dev'] })

  const ui = readyCard(db, { position: 1 })
  const im = readyCard(db, { position: 2, skill: 'marketing', group: 'IM' })
  const blocked = seedCard(db, { phase: 'task', status: 'blocked', position: 3, holder: 'developer', group: 'OPS' })

  const byGroup = nowData(db, { view: 3, executorId: 'owner', filters: { group: 'UI' }, root })
  assert.deepEqual(byGroup.queue!.map((card) => card.id), [ui.id])

  const bySkill = nowData(db, { view: 3, executorId: 'owner', filters: { skill: 'marketing' }, root })
  assert.deepEqual(bySkill.queue!.map((card) => card.id), [im.id])

  const byStatus = nowData(db, { view: 3, executorId: 'owner', filters: { status: 'blocked' }, root })
  assert.deepEqual(byStatus.queue!.map((card) => card.id), [blocked.id])

  const mine = nowData(db, { view: 3, executorId: 'developer', filters: { mine: true }, root })
  assert.deepEqual(mine.queue!.map((card) => card.id), [blocked.id])
})

test('now 0: утвердить, задачи владельца и открытые вопросы', (t) => {
  const { db, root } = board(t)

  const approval = seedCard(db, { phase: 'task', status: 'approval', skill: 'dev', importance: 3, urgency: 2 })
  const ownerCard = seedCard(db, { skill: 'owner', status: 'ready', title: 'Создать VK группу' })
  const answered = seedCard(db, { phase: 'task', status: 'ready', title: 'Прошлый вопрос' })
  ask(db, { cardId: answered.id, author: 'developer', text: 'Отвечен' })
  ask(db, { cardId: approval.id, author: 'developer', text: 'Нужен ли SSO?' })

  const data = nowData(db, { view: 0, executorId: 'owner', root })

  assert.deepEqual(data.approvals!.map((card) => card.id), [approval.id])
  assert.deepEqual(data.ownerCards!.map((card) => card.id), [ownerCard.id])
  assert.equal(data.questions!.length, 2)
  assert.ok(data.questions!.every((question) => question.status === 'open'))
})

test('now 1: агенту — три предложения забега; владельцу — по одному на агента', (t) => {
  const { db, root } = board(t)
  seedExecutor(db, { id: 'developer', skills: ['dev'] })
  seedExecutor(db, { id: 'marketer', skills: ['marketing'] })

  readyCard(db, { position: 1 })
  readyCard(db, { position: 2, skill: 'marketing', group: 'IM' })
  readyCard(db, { position: 3 })

  const agent = nowData(db, { view: 1, executorId: 'developer', root })
  assert.ok(agent.suggestions!.length <= 3)
  assert.ok(agent.suggestions!.every((run) => run.executorId === 'developer'))

  const owner = nowData(db, { view: 1, executorId: 'owner', root })
  assert.equal(owner.suggestions!.length, 2)
  assert.deepEqual(
    owner.suggestions!.map((run) => run.executorId).sort(),
    ['developer', 'marketer'],
  )
})

test('now 1: владельцу не больше трёх забегов', (t) => {
  const { db, root } = board(t)
  for (const [id, skill] of [
    ['developer', 'dev'],
    ['marketer', 'marketing'],
    ['writer', 'writing'],
    ['designer', 'design'],
  ] as const) {
    seedExecutor(db, { id, skills: [skill] })
    readyCard(db, { position: 1, skill, group: 'UI' })
  }

  const data = nowData(db, { view: 1, executorId: 'owner', root })
  assert.equal(data.suggestions!.length, 3)
})

test('now 2: активные и завершённые забеги + по предложению на чужого исполнителя', (t) => {
  const { db, root } = board(t)
  seedExecutor(db, { id: 'developer', skills: ['dev'] })
  seedExecutor(db, { id: 'marketer', skills: ['marketing'] })

  const active = seedRun(db, { executorId: 'developer' })
  seedRun(db, { executorId: 'marketer', status: 'ended' })
  readyCard(db, { position: 1 })
  readyCard(db, { position: 2, skill: 'marketing', group: 'IM' })

  const data = nowData(db, { view: 2, executorId: 'owner', root })

  assert.ok(data.runs!.some((run) => run.id === active.id))
  assert.equal(data.runs!.length, 2)
  assert.deepEqual(
    data.suggestions!.map((run) => run.executorId).sort(),
    ['developer', 'marketer'],
  )
})

test('now 2: текущий исполнитель исключается из предложений', (t) => {
  const { db, root } = board(t)
  seedExecutor(db, { id: 'developer', skills: ['dev'] })
  seedExecutor(db, { id: 'marketer', skills: ['marketing'] })

  readyCard(db, { position: 1 })
  readyCard(db, { position: 2, skill: 'marketing', group: 'IM' })

  const data = nowData(db, { view: 2, executorId: 'developer', root })
  assert.deepEqual(data.suggestions!.map((run) => run.executorId), ['marketer'])
})

test('now: неизвестная вкладка — ошибка', (t) => {
  const { db, root } = board(t)
  assert.throws(() => nowData(db, { view: 9 as never, executorId: 'owner', root }), /вкладка/)
})
