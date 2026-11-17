import test from 'node:test'
import assert from 'node:assert/strict'
import { openDb, migrate, type DatabaseSync } from '../../src/core/db.ts'
import { SCHEMA_VERSION } from '../../src/core/schema.ts'
import { addRoutine } from '../../src/core/routines.ts'
import {
  activeRun,
  getRunRecord,
  lastClosedRun,
  listRuns,
  materialize,
  startRun,
  type RunMode,
} from '../../src/core/runs.ts'
import { listEvents } from '../../src/core/events.ts'

function fixture(db: DatabaseSync) {
  return addRoutine(db, { name: 'Деплой', schedule: 'daily 09:00' })
}

function close(db: DatabaseSync, id: string, reason = 'задачи закончились', at = '2026-11-18T06:00:00.000Z') {
  db.prepare('update runs set ended_at = ?, end_reason = ? where id = ?').run(at, reason, id)
}

test('прогон материализуется заранее и не дублируется', () => {
  const db = openDb(':memory:')
  fixture(db)

  const now = new Date('2026-11-16T00:00:00')
  const runs = materialize(db, { now })
  assert.equal(runs.length, 2)
  assert.equal(materialize(db, { now }).length, 0)
  assert.equal(listRuns(db).length, 2)
})

test('прогон не создаётся раньше окна материализации', () => {
  const db = openDb(':memory:')
  const routine = addRoutine(db, { name: 'Деплой', schedule: 'every 30d 09:00' })
  assert.equal(materialize(db, { now: new Date('2026-11-16T00:00:00') }).length, 0)
  assert.equal(listRuns(db).length, 0)
  assert.ok(routine.id)
})

test('run start сохраняет режим, запросы, утверждение и питание', () => {
  const db = openDb(':memory:')
  const run = startRun(db, {
    mode: 'all',
    requests: ['R2', 'R1', 'R2'],
    approve: true,
    power: 'hibernate',
    actor: 'owner',
    now: new Date('2026-11-17T20:00:00.000Z'),
  })

  assert.equal(run.id, 'RUN1')
  assert.equal(run.mode, 'all')
  assert.deepEqual(run.requests, ['R2', 'R1'])
  assert.equal(run.nearest, false)
  assert.equal(run.approve, true)
  assert.equal(run.power, 'hibernate')
  assert.equal(run.startedAt, '2026-11-17T20:00:00.000Z')
  assert.equal(run.endedAt, null)
  assert.equal(run.endReason, null)

  // прогон — строка в базе, а не запись в чате
  assert.deepEqual(getRunRecord(db, 'RUN1'), run)
  const row = db.prepare('select power, started_at from runs where id = ?').get('RUN1') as {
    power: string
    started_at: string
  }
  assert.equal(row.power, 'hibernate')
  assert.equal(row.started_at, '2026-11-17T20:00:00.000Z')

  const events = listEvents(db, { subject: 'RUN1' })
  assert.equal(events.length, 1)
  assert.equal(events[0].type, 'run.started')
})

test('run show берёт активный прогон и последний закрытый', () => {
  const db = openDb(':memory:')

  const first = startRun(db, { mode: 'plan', requests: ['R1'], now: new Date('2026-11-17T20:00:00.000Z') })
  close(db, first.id)
  const second = startRun(db, { mode: 'all', approve: true, now: new Date('2026-11-18T08:00:00.000Z') })

  assert.equal(activeRun(db)?.id, second.id)
  assert.equal(second.id, 'RUN2')
  assert.equal(lastClosedRun(db)?.id, first.id)
  assert.equal(lastClosedRun(db)?.endReason, 'задачи закончились')
})

test('нет открытого прогона — show не врёт про активный', () => {
  const db = openDb(':memory:')
  assert.equal(activeRun(db), null)
  assert.equal(lastClosedRun(db), null)

  const run = startRun(db, { mode: 'plan' })
  close(db, run.id, 'остановил владелец')

  assert.equal(activeRun(db), null)
  assert.equal(lastClosedRun(db)?.endReason, 'остановил владелец')
})

test('ближайшие вместе с доталово отвергаются с объяснением', () => {
  const db = openDb(':memory:')

  assert.throws(
    () => startRun(db, { mode: 'all', nearest: true }),
    /это взаимоисключающие варианты/,
  )

  // отказ не оставляет недописанного прогона
  assert.equal(activeRun(db), null)
  assert.equal(listEvents(db).length, 0)

  // по отдельности оба варианта работают
  const nearest = startRun(db, { mode: 'plan', nearest: true })
  assert.equal(nearest.nearest, true)
  close(db, nearest.id)
  assert.equal(startRun(db, { mode: 'all' }).mode, 'all')
})

test('второй прогон без закрытия первого не начинается', () => {
  const db = openDb(':memory:')
  const first = startRun(db, { mode: 'plan', now: new Date('2026-11-17T20:00:00.000Z') })

  assert.throws(
    () => startRun(db, { mode: 'plan' }),
    new RegExp(`прогон ${first.id} ещё не закрыт`),
  )

  close(db, first.id)
  assert.equal(startRun(db, { mode: 'plan' }).id, 'RUN2')
})

test('неизвестный режим или питание не записываются', () => {
  const db = openDb(':memory:')

  assert.throws(() => startRun(db, { mode: 'total' as RunMode }), /plan или all/)
  assert.throws(() => startRun(db, { mode: 'plan', power: 'sleep' as 'none' }), /none, hibernate или shutdown/)
  assert.equal(activeRun(db), null)
})

test('нумерация RUN не путается с рутинными прогонами', () => {
  const db = openDb(':memory:')
  fixture(db)
  assert.equal(materialize(db, { now: new Date('2026-11-16T00:00:00') }).length, 2)

  assert.equal(startRun(db, { mode: 'plan' }).id, 'RUN1')
})

test('миграция 9 → 10 создаёт таблицу прогонов', () => {
  const db = openDb(':memory:')
  assert.ok(SCHEMA_VERSION >= 10)

  // откатываемся к схеме 9: таблицы прогонов ещё нет
  db.exec('drop table runs')
  db.prepare("update meta set value = '9' where key = 'schemaVersion'").run()

  assert.ok(migrate(db) >= 10)

  const columns = (
    db.prepare("select name from pragma_table_info('runs')").all() as Array<{ name: string }>
  ).map((column) => column.name)
  for (const column of ['id', 'mode', 'requests', 'approve', 'power', 'started_at', 'ended_at', 'end_reason']) {
    assert.ok(columns.includes(column), `у прогона есть колонка ${column}`)
  }

  // и запись ложится в новую таблицу
  assert.equal(startRun(db, { mode: 'plan' }).id, 'RUN1')
})

