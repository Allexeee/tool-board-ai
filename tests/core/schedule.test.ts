import test from 'node:test'
import assert from 'node:assert/strict'
import { parseSchedule, nextRun, inWindow } from '../../src/core/schedule.ts'

test('daily считается на следующий день после времени', () => {
  const s = parseSchedule('daily 02:00')

  const same = nextRun(s, new Date('2026-11-16T01:00:00'))
  assert.equal(same.getDate(), 16)
  assert.equal(same.getHours(), 2)

  const next = nextRun(s, new Date('2026-11-16T03:00:00'))
  assert.equal(next.getDate(), 17)
  assert.equal(next.getHours(), 2)
})

test('weekly учитывает дни недели', () => {
  const s = parseSchedule('weekly 1,3 09:00')
  const next = nextRun(s, new Date('2026-11-16T10:00:00'))
  assert.equal(next.getDay(), 3)
  assert.equal(next.getHours(), 9)
})

test('every Nd сдвигает на N дней', () => {
  const s = parseSchedule('every 7d 09:00')
  const next = nextRun(s, new Date('2026-11-16T10:00:00'))
  assert.equal(next.getDate(), 23)
})

test('окно переходит через полночь', () => {
  assert.equal(inWindow('22:00-04:00', new Date('2026-11-16T23:30:00')), true)
  assert.equal(inWindow('22:00-04:00', new Date('2026-11-16T12:00:00')), false)
  assert.equal(inWindow('02:00-04:00', new Date('2026-11-16T03:00:00')), true)
})

test('мусор в расписании отвергается', () => {
  assert.throws(() => parseSchedule('когда-нибудь'), /расписан/)
  assert.throws(() => parseSchedule('daily 25:00'), /время/)
})
