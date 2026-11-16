import test from 'node:test'
import assert from 'node:assert/strict'
import { openDb } from '../../src/core/db.ts'
import { doctorReport } from '../../src/core/doctor.ts'
import { ok, setJsonMode } from '../../src/cli/output.ts'

test('doctor сообщает о незавершённой настройке', () => {
  const db = openDb(':memory:')
  const report = doctorReport(db)
  assert.ok(report.checks.some((check) => check.name === 'исполнители' && !check.ok))
})

test('--json печатает ровно один JSON-объект', () => {
  const chunks: string[] = []
  const original = process.stdout.write.bind(process.stdout)
  process.stdout.write = ((chunk: string) => {
    chunks.push(String(chunk))
    return true
  }) as typeof process.stdout.write

  try {
    setJsonMode(true)
    ok({ a: 1 }, 'человеку')
  } finally {
    process.stdout.write = original
    setJsonMode(false)
  }

  const output = chunks.join('')
  assert.deepEqual(JSON.parse(output), { a: 1 })
  assert.equal(output.trim().split('\n').length, 1)
})
