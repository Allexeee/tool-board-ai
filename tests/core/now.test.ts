import test from 'node:test'
import assert from 'node:assert/strict'
import type { DatabaseSync } from 'node:sqlite'
import { nowIso } from '../../src/core/clock.ts'
import { ask } from '../../src/core/discussion.ts'
import { nowData, renderNow } from '../../src/core/now.ts'
import { moveCard } from '../../src/core/queue.ts'
import { deferCard } from '../../src/core/lifecycle.ts'
import { editCard } from '../../src/core/cards.ts'
import { makeBoard, seedCard, seedExecutor } from '../helpers/board.ts'

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
  input: { position: number; skill?: string; group?: string; tags?: string[] },
) {
  return seedCard(db, {
    phase: 'task',
    status: 'ready',
    position: input.position,
    skill: input.skill ?? 'dev',
    group: input.group ?? 'UI',
    importance: 3,
    urgency: 3,
    tags: input.tags,
  })
}

const ANSI = /\u001b\[[0-9;]*m/g
const stripAnsi = (text: string): string => text.replace(ANSI, '')

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

test('now 3: запросы — только открытые, до 10 по времени создания и счётчик «ещё»', (t) => {
  const { db, root } = board(t)

  for (let i = 0; i < 12; i++) {
    seedCard(db, { phase: 'request', status: 'new', title: `Запрос ${i}` })
  }
  seedCard(db, { phase: 'request', status: 'cancelled', title: 'Отменённый' })
  seedCard(db, { phase: 'request', status: 'done', title: 'Закрытый' })

  const data = nowData(db, { view: 3, executorId: 'owner', root })
  assert.equal(data.requests!.length, 10)
  assert.equal(data.moreRequests, 2)
  assert.ok(data.requests!.every((card) => card.phase === 'request'))
  assert.ok(
    data.requests!.every((card) => card.status !== 'cancelled' && card.status !== 'done'),
  )
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
  const ownerWaiting = seedCard(db, { skill: 'owner', status: 'waiting', title: 'Ждёт зависимости' })
  const answered = seedCard(db, { phase: 'task', status: 'ready', title: 'Прошлый вопрос' })
  ask(db, { cardId: answered.id, author: 'developer', text: 'Отвечен' })
  ask(db, { cardId: approval.id, author: 'developer', text: 'Нужен ли SSO?' })

  const data = nowData(db, { view: 0, executorId: 'owner', root })

  assert.deepEqual(data.approvals!.map((card) => card.id), [approval.id])
  assert.deepEqual(data.ownerCards!.map((card) => card.id).sort(), [ownerCard.id, ownerWaiting.id].sort())
  assert.equal(data.questions!.length, 2)
  assert.ok(data.questions!.every((question) => question.status === 'open'))
})

test('now 1: задачи агента на руках и очередь по его навыкам', (t) => {
  const { db, root } = board(t)
  seedExecutor(db, { id: 'developer', skills: ['dev', 'backend'] })
  seedExecutor(db, { id: 'marketer', skills: ['marketing'] })

  const inWork = seedCard(db, { phase: 'task', status: 'in_progress', holder: 'developer' })
  const review = seedCard(db, { phase: 'task', status: 'review', holder: 'developer' })
  const request = seedCard(db, { phase: 'request', status: 'new', tags: ['new'] })
  const ownQueue = readyCard(db, { position: 1, tags: ['new'] })
  const backendQueue = readyCard(db, { position: 2, skill: 'backend', group: 'API', tags: ['improve'] })
  const waiting = seedCard(db, {
    phase: 'task',
    status: 'waiting',
    position: 3,
    skill: 'dev',
    tags: ['review'],
  })
  const foreignQueue = seedCard(db, {
    phase: 'task',
    status: 'ready',
    position: 4,
    skill: 'marketing',
    group: 'IM',
  })
  const foreignHeld = seedCard(db, {
    phase: 'task',
    status: 'in_progress',
    holder: 'marketer',
    skill: 'dev',
  })
  const heldQueue = seedCard(db, {
    phase: 'task',
    status: 'ready',
    position: 5,
    skill: 'dev',
    holder: 'marketer',
  })

  const data = nowData(db, { view: 1, executorId: 'developer', root })

  assert.equal(data.view, 1)
  assert.equal(data.executor, 'developer')
  assert.deepEqual(data.skills, ['dev', 'backend'])
  assert.deepEqual(
    data.cards!.map((card) => card.id).sort(),
    [inWork.id, review.id, request.id, ownQueue.id, backendQueue.id, waiting.id].sort(),
  )
  assert.deepEqual(data.probableRuns!.map((run) => run.tag), ['new', 'improve', 'review'])
  assert.equal(data.probableRuns![0].cards[0].card.id, request.id)
  assert.equal(data.probableRuns![0].cards[0].request, true)
  assert.equal(data.untagged, 2)
  for (const card of [foreignQueue, foreignHeld, heldQueue]) {
    assert.ok(!data.cards!.some((item) => item.id === card.id))
  }
  assert.equal('suggestions' in data, false)
  assert.equal('runs' in data, false)
  assert.equal('currentRun' in data, false)
})

test('now 1: у агента без карточек пустой список, у владельца — тоже', (t) => {
  const { db, root } = board(t)
  seedExecutor(db, { id: 'developer', skills: ['dev'] })

  const agent = nowData(db, { view: 1, executorId: 'developer', root })
  assert.deepEqual(agent.cards, [])

  const owner = nowData(db, { view: 1, executorId: 'owner', root })
  assert.deepEqual(owner.cards, [])
})

test('now 2: задачи по всем агентам без выделения текущего', (t) => {
  const { db, root } = board(t)
  seedExecutor(db, { id: 'developer', skills: ['dev'] })
  seedExecutor(db, { id: 'marketer', skills: ['marketing'] })
  seedExecutor(db, { id: 'writer', skills: ['writing'] })

  const devHeld = seedCard(db, { phase: 'task', status: 'in_progress', holder: 'developer' })
  const devQueue = readyCard(db, { position: 1 })
  const marketerQueue = readyCard(db, { position: 2, skill: 'marketing', group: 'IM' })

  const data = nowData(db, { view: 2, executorId: 'developer', root })

  assert.equal(data.view, 2)
  assert.equal('executor' in data, false)
  assert.equal('suggestions' in data, false)
  assert.deepEqual(data.executors!.map((item) => item.id), ['marketer'])
  const marketer = data.executors![0]
  assert.deepEqual(marketer.cards.map((card) => card.id), [marketerQueue.id])
  assert.ok(!data.executors!.some((item) => item.cards.some((card) => card.id === devHeld.id)))
  assert.ok(!data.executors!.some((item) => item.cards.some((card) => card.id === devQueue.id)))
})

test('now 1/2: единый список КАРТОЧКИ, без секций запросы/на руках/очередь', (t) => {
  const { db, root } = board(t)
  seedExecutor(db, { id: 'developer', skills: ['dev'] })

  seedCard(db, { phase: 'task', status: 'in_progress', holder: 'developer' })
  readyCard(db, { position: 1, tags: ['new'] })
  seedCard(db, { phase: 'request', status: 'new', title: 'Запрос' })

  const one = nowData(db, { view: 1, executorId: 'developer', root })
  const text = renderNow(one)
  assert.match(text, /\[1\] МОИ ЗАДАЧИ/)
  assert.doesNotMatch(text, /МОИ ЗАДАЧИ —/)
  assert.match(text, /КАРТОЧКИ \(3\)/)
  assert.doesNotMatch(text, /НА РУКАХ|ОЧЕРЕДЬ|ЗАПРОСЫ/)
  assert.match(text, /ВЕРОЯТНЫЕ ЗАБЕГИ/)
  assert.match(text, /НОВОЕ/)
  assert.doesNotMatch(text, /ФИЧИ|ФИКСЫ/)

  const two = nowData(db, { view: 2, executorId: 'owner', root })
  const all = renderNow(two)
  assert.match(all, /\[2\] ЗАДАЧИ ПО АГЕНТАМ/)
  assert.match(all, /developer/)
  assert.doesNotMatch(all, /МОИ ЗАДАЧИ|ФИЧИ|ФИКСЫ/)
})

test('now 3: текст с открытыми запросами и очередью', (t) => {
  const { db, root } = board(t)
  seedCard(db, { phase: 'request', status: 'new', title: 'Запрос' })
  readyCard(db, { position: 1 })

  const data = nowData(db, { view: 3, executorId: 'owner', root })
  const text = renderNow(data)
  assert.match(text, /\[3\] ЗАПРОСЫ И ОЧЕРЕДЬ/)
  assert.match(text, /ЗАПРОСЫ \(1\)/)
  assert.match(text, /ОЧЕРЕДЬ \(1\)/)
  assert.match(text, /СДЕЛАНО СЕГОДНЯ/)
})

test('now: без цвета по умолчанию, цвета только при color=true', (t) => {
  const { db, root } = board(t)
  seedExecutor(db, { id: 'developer', skills: ['dev'] })
  seedCard(db, { phase: 'task', status: 'review', holder: 'developer' })
  readyCard(db, { position: 1 })

  const data = nowData(db, { view: 1, executorId: 'developer', root })

  const plain = renderNow(data)
  assert.equal(ANSI.test(plain), false)
  assert.equal(stripAnsi(plain), plain)

  const colored = renderNow(data, { color: true })
  assert.match(colored, /\u001b\[[0-9;]*m/)
  assert.equal(stripAnsi(colored), plain)
})

test('now: неизвестная вкладка — ошибка', (t) => {
  const { db, root } = board(t)
  assert.throws(() => nowData(db, { view: 9 as never, executorId: 'owner', root }), /вкладка/)
})

test('отложенные не видны агенту, владелец видит счётчик', (t) => {
  const { db } = board(t)
  seedExecutor(db, { id: 'developer', skills: ['dev'] })
  const task = readyCard(db, { position: 1 })
  const request = seedCard(db, { phase: 'request', status: 'new' })

  deferCard(db, { id: task.id, actor: 'developer' })
  deferCard(db, { id: request.id, actor: 'developer' })

  const mine = nowData(db, { view: 1, executorId: 'developer' })
  assert.equal(mine.cards?.some((card) => card.id === task.id) ?? false, false)
  assert.equal(
    mine.probableRuns?.some((run) => run.cards.some((item) => item.card.id === task.id)) ?? false,
    false,
  )

  const queue = nowData(db, { view: 3, executorId: 'developer' })
  assert.equal(queue.requests?.some((card) => card.id === request.id) ?? false, false)

  const owner = nowData(db, { view: 0, executorId: 'owner' })
  assert.equal(owner.deferredCount, 2)
  assert.match(stripAnsi(renderNow(owner)), /ОТЛОЖЕНО \(2\)/)
})

test('owner-карточка после смены навыка не видна в now 3 и видна владельцу', (t) => {
  const { db } = board(t)
  const card = seedCard(db, { phase: 'request', status: 'new', title: 'Стать owner' })
  editCard(db, { id: card.id, actor: 'owner', patch: { skill: 'owner', needsMerge: false } })

  const requestsView = nowData(db, { view: 3, executorId: 'owner' })
  assert.equal(requestsView.requests?.some((item) => item.id === card.id) ?? false, false)

  const ownerView = nowData(db, { view: 0, executorId: 'owner' })
  assert.equal(ownerView.ownerCards?.some((item) => item.id === card.id) ?? false, true)
})

test('now 0 показывает счётчик карточек на ревью', (t) => {
  const { db } = board(t)
  seedCard(db, { phase: 'task', status: 'review', holder: 'developer' })

  const owner = nowData(db, { view: 0, executorId: 'owner' })
  assert.equal(owner.reviewCount, 1)
  assert.match(stripAnsi(renderNow(owner)), /НА РЕВЬЮ \(1\)/)
})

test('now показывает «ждёт финального ревью» у карточки на ревью', (t) => {
  const { db } = board(t)
  seedExecutor(db, { id: 'developer', skills: ['dev'] })
  seedCard(db, {
    phase: 'task',
    status: 'review',
    holder: 'developer',
    skill: 'dev',
    position: 1,
  })

  const view = nowData(db, { view: 1, executorId: 'developer' })
  assert.match(stripAnsi(renderNow(view)), /ждёт финального ревью/)
})

test('now 3: owner после --bottom идёт последним в своей очереди', (t) => {
  const { db, root } = board(t)
  const first = seedCard(db, { phase: 'task', status: 'ready', skill: 'owner', position: 1 })
  const second = seedCard(db, { phase: 'task', status: 'ready', skill: 'owner', position: 2 })
  const dev = readyCard(db, { position: 1 })

  moveCard(db, first.id, { bottom: true })

  const data = nowData(db, { view: 3, executorId: 'owner', root })
  assert.deepEqual(
    data.queue!.map((card) => card.id),
    [second.id, first.id, dev.id],
  )
})
