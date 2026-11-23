import test from 'node:test'
import assert from 'node:assert/strict'
import { retryOnBusy } from '../../src/core/db.ts'

function busyError(): Error {
  return Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' })
}

test('retryOnBusy: повторяет SQLITE_BUSY и возвращает результат', () => {
  let calls = 0
  const value = retryOnBusy(() => {
    calls += 1
    if (calls < 3) throw busyError()
    return 'ok'
  })
  assert.equal(value, 'ok')
  assert.equal(calls, 3)
})

test('retryOnBusy: сдаётся после лимита попыток', () => {
  let calls = 0
  assert.throws(
    () =>
      retryOnBusy(() => {
        calls += 1
        throw busyError()
      }, 3),
    /database is locked/,
  )
  assert.equal(calls, 3)
})

test('retryOnBusy: не глотает другие ошибки', () => {
  let calls = 0
  assert.throws(
    () =>
      retryOnBusy(() => {
        calls += 1
        throw new Error('syntax error')
      }),
    /syntax error/,
  )
  assert.equal(calls, 1)
})
