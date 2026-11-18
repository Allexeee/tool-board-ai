import test from 'node:test'
import assert from 'node:assert/strict'
import { openDb } from '../../src/core/db.ts'
import { addRequest } from '../../src/core/requests.ts'
import { addFeature } from '../../src/core/features.ts'
import { addStage, activateNextStage } from '../../src/core/stages.ts'
import { createTask, updateTask } from '../../src/core/tasks.ts'
import { appendEvent } from '../../src/core/events.ts'
import { refreshReady } from '../../src/core/deps.ts'
import { formatWeek, reviewWeek } from '../../src/core/week.ts'

function fixture() {
  const db = openDb(':memory:')
  const request = addRequest(db, { title: 'Оплата', body: '...', author: 'owner' })
  const feature = addFeature(db, { requestId: request.id, name: 'A', rank: 1 })
  const stage = addStage(db, { featureId: feature.id, name: 'S1', goal: 'g', appetite: '1 день' })
  activateNextStage(db, feature.id)

  const base = {
    stageId: stage.id,
    dod: ['a'],
    size: 'S' as const,
    skill: 'backend',
    scope: ['src/**'],
  }
  const first = createTask(db, { ...base, title: 'Обычная', class: 'standard' })
  const second = createTask(db, { ...base, title: 'Срочная', class: 'expedite' })
  refreshReady(db)

  return { db, feature, first, second }
}

test('review week считает переоткрытия, блокировки и срочные', () => {
  const { db, feature, first, second } = fixture()
  updateTask(db, first.id, { status: 'done' })
  appendEvent(db, { type: 'task.reopened', actor: 'owner', subject: first.id })
  appendEvent(db, { type: 'task.blocked', actor: 'w1', subject: second.id, note: 'needs_decision' })

  const report = reviewWeek(db, { days: 7 })
  const row = report.features.find((item) => item.featureId === feature.id)!

  assert.equal(row.tasks, 2)
  assert.equal(row.done, 1)
  assert.equal(row.reopens, 1)
  assert.equal(row.blocks, 1)
  assert.equal(row.urgent, 1)
  assert.equal(report.totals.urgentShare, 50)
  assert.match(formatWeek(report), /срочных: 50%/)
})

test('review week молчит, когда работы не было', () => {
  const { db } = fixture()
  const report = reviewWeek(db, { days: 7, now: new Date('2030-01-01T00:00:00.000Z') })

  assert.deepEqual(report.features, [])
  assert.match(formatWeek(report), /работы не было/)
})

/** Журнал пишет время сам; тесту нужны события в прошлом — правим at после записи. */
function backdate(db: ReturnType<typeof openDb>, at: string, subject: string, type?: string) {
  if (type) db.prepare('update events set at = ? where subject = ? and type = ?').run(at, subject, type)
  else db.prepare('update events set at = ? where subject = ?').run(at, subject)
}

test('фича месячной давности не попадает в неделю', () => {
  const { db, first, second } = fixture()
  const now = new Date('2026-11-18T12:00:00.000Z')

  // вся жизнь фичи — месяц назад: под заголовком «за 7 дней» её быть не должно
  backdate(db, '2026-10-11T09:00:00.000Z', first.id)
  backdate(db, '2026-10-11T09:00:00.000Z', second.id)

  const report = reviewWeek(db, { days: 7, now })

  assert.deepEqual(report.features, [], 'старая фича не выдаёт пожизненные числа за неделю')
  assert.equal(report.totals.hours, 0)
  assert.match(formatWeek(report), /работы не было/)
})

test('фича из прошлого, активная в окне, даёт часы только за окно', () => {
  const { db, feature, first, second } = fixture()
  const now = new Date('2026-11-18T12:00:00.000Z')

  // фича началась месяц назад, последнее событие — в окне
  backdate(db, '2026-10-11T09:00:00.000Z', first.id)
  backdate(db, '2026-10-11T09:00:00.000Z', second.id)
  appendEvent(db, { type: 'task.taken', actor: 'w1', subject: first.id })
  backdate(db, '2026-11-18T10:00:00.000Z', first.id, 'task.taken')

  const report = reviewWeek(db, { days: 7, now })
  const row = report.features.find((item) => item.featureId === feature.id)!

  // окно: 11.11 12:00 → 18.11 10:00 = 6 дней 22 часа, а не месяц жизни фичи
  assert.equal(row.hours, 166)
  assert.equal(report.totals.hours, 166)
  assert.equal(row.tasks, 1, 'в окне трогали одну задачу из двух')
  assert.equal(row.done, 0)
})

test('переоткрытия и блокировки до окна в неделю не попадают', () => {
  const { db, feature, first, second } = fixture()
  const now = new Date()

  appendEvent(db, { type: 'task.reopened', actor: 'owner', subject: first.id })
  appendEvent(db, { type: 'task.blocked', actor: 'w1', subject: second.id, note: 'needs_decision' })
  const longAgo = new Date(now.getTime() - 40 * 24 * 3600 * 1000).toISOString()
  backdate(db, longAgo, first.id, 'task.reopened')
  backdate(db, longAgo, second.id, 'task.blocked')

  // задача осталась в окне другим событием: переоткрытие старое, а работа свежая
  appendEvent(db, { type: 'task.taken', actor: 'w1', subject: first.id })
  updateTask(db, first.id, { status: 'done' })

  const report = reviewWeek(db, { days: 7, now })
  const row = report.features.find((item) => item.featureId === feature.id)!

  assert.equal(row.reopens, 0, 'старое переоткрытие не считается недельным')
  assert.equal(row.blocks, 0, 'старая блокировка не считается недельной')
  assert.equal(row.tasks, 1, 'в окне трогали только первую задачу')
  assert.equal(row.done, 1)
})
