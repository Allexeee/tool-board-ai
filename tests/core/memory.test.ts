import test from 'node:test'
import assert from 'node:assert/strict'
import { openDb, type DatabaseSync } from '../../src/core/db.ts'
import { addRequest } from '../../src/core/requests.ts'
import { addFeature } from '../../src/core/features.ts'
import { addStage, activateNextStage } from '../../src/core/stages.ts'
import { createTask } from '../../src/core/tasks.ts'
import { appendEvent } from '../../src/core/events.ts'
import { failureMemory, formatFailureMemory, pathScope } from '../../src/core/memory.ts'

function fixture() {
  const db = openDb(':memory:')
  const request = addRequest(db, { title: 'Память', body: '...', author: 'owner' })
  const feature = addFeature(db, { requestId: request.id, name: 'A', rank: 1 })
  const stage = addStage(db, { featureId: feature.id, name: 'S1', goal: 'g', appetite: '1 день' })
  activateNextStage(db, feature.id)

  const base = {
    stageId: stage.id,
    dod: ['a'],
    size: 'S' as const,
    skill: 'backend',
    class: 'standard' as const,
  }
  const hands = createTask(db, { ...base, title: 'Проводка hands', scope: ['src/core/hands.ts'] })
  const lease = createTask(db, { ...base, title: 'Аренда', scope: ['src/core/lease.ts'] })
  const docs = createTask(db, { ...base, title: 'Документация', scope: ['docs/**'] })
  const quiet = createTask(db, { ...base, title: 'Тихая', scope: ['src/core/git/scope.ts'] })

  return { db, hands, lease, docs, quiet }
}

/** Метка времени события: без неё два события одной миллисекунды не различить. */
function stamp(db: DatabaseSync, subject: string, at: string) {
  db.prepare('update events set at = ? where subject = ?').run(at, subject)
}

test('memory по файлу находит блокировку и разбирает её заметку', () => {
  const { db, hands, lease, docs } = fixture()

  appendEvent(db, {
    type: 'task.blocked',
    actor: 'w1',
    subject: hands.id,
    note: 'needs_decision: нужен выбор владельца сессии',
  })
  appendEvent(db, { type: 'task.reopened', actor: 'owner', subject: lease.id, note: 'упал тест на винде' })
  appendEvent(db, { type: 'task.blocked', actor: 'w2', subject: docs.id, note: 'needs_data: нет схемы' })
  stamp(db, hands.id, '2026-11-17T09:05:00.000Z')
  stamp(db, lease.id, '2026-11-18T08:30:00.000Z')
  stamp(db, docs.id, '2026-11-18T09:00:00.000Z')

  const records = failureMemory(db, 'src/core/hands.ts')

  assert.deepEqual(records.map((record) => record.taskId), [hands.id], 'чужая область не попадает')
  assert.equal(records[0].taskTitle, 'Проводка hands')
  assert.equal(records[0].kind, 'block')
  assert.equal(records[0].reason, 'needs_decision')
  assert.equal(records[0].note, 'нужен выбор владельца сессии')
})

test('memory по каталогу собирает блок и переоткрытие, свежие сверху', () => {
  const { db, hands, lease, docs, quiet } = fixture()

  appendEvent(db, {
    type: 'task.blocked',
    actor: 'w1',
    subject: hands.id,
    note: 'needs_access: нет доступа к репозиторию',
  })
  appendEvent(db, { type: 'task.reopened', actor: 'owner', subject: lease.id, note: 'флаки тест на винде' })
  appendEvent(db, { type: 'task.blocked', actor: 'w2', subject: docs.id, note: 'needs_data: нет схемы' })
  stamp(db, hands.id, '2026-11-17T09:05:00.000Z')
  stamp(db, lease.id, '2026-11-18T08:30:00.000Z')
  stamp(db, docs.id, '2026-11-18T09:00:00.000Z')

  const records = failureMemory(db, 'src/core')

  assert.deepEqual(
    records.map((record) => record.taskId),
    [lease.id, hands.id],
    'свежее событие выше, тихая задача и чужая область не попадают',
  )
  assert.deepEqual(
    records.map((record) => record.kind),
    ['reopen', 'block'],
  )
  assert.equal(records[0].reason, 'флаки тест на винде')
  assert.ok(!records.some((record) => record.taskId === quiet.id), 'без событий неудачи нет')

  const text = formatFailureMemory(records)
  const lines = text.split('\n')
  assert.equal(lines.length, 2)
  assert.match(lines[0]!, /переоткрытие/)
  assert.match(lines[0]!, /флаки тест на винде/)
  assert.match(lines[1]!, /блок/)
  assert.match(lines[1]!, /needs_access: нет доступа к репозиторию/)
})

test('memory в области без неудач отвечает словами, а не пустотой', () => {
  const { db } = fixture()

  const records = failureMemory(db, 'src/cli')

  assert.deepEqual(records, [])
  assert.equal(formatFailureMemory(records), 'в этой области неудач не было')
})

test('pathScope считает каталог каталогом целиком, маску оставляет как есть', () => {
  assert.deepEqual(pathScope('src/core/'), ['src/core', 'src/core/**'])
  assert.deepEqual(pathScope('./src/core/hands.ts'), ['src/core/hands.ts', 'src/core/hands.ts/**'])
  assert.deepEqual(pathScope('src/core/*'), ['src/core/*'])
})
