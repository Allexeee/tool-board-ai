import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { withFileLock } from '../../src/core/lock.ts'
import { backupDatabase } from '../../src/core/backup.ts'
import { openDb } from '../../src/core/db.ts'

function tempDir(t: { after: (fn: () => void) => void }): string {
  const dir = mkdtempSync(join(tmpdir(), 'board-hygiene-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

test('lock: мёртвый PID считается мусором', (t) => {
  const dir = tempDir(t)
  const lock = join(dir, '.lock')
  writeFileSync(lock, '999999', 'utf8')

  assert.equal(withFileLock(lock, () => 'ok'), 'ok')
  assert.equal(existsSync(lock), false)
})

test('lock: старый по возрасту снимается', (t) => {
  const dir = tempDir(t)
  const lock = join(dir, '.lock')
  writeFileSync(lock, String(process.pid), 'utf8')
  const old = new Date(Date.now() - 60 * 60 * 1000)
  utimesSync(lock, old, old)

  assert.equal(withFileLock(lock, () => 'ok'), 'ok')
})

test('lock: живой свежий lock не снимается', (t) => {
  const dir = tempDir(t)
  const lock = join(dir, '.lock')
  writeFileSync(lock, String(process.pid), 'utf8')

  assert.throws(() => withFileLock(lock, () => 'ok'), /таймаут блокировки/)
  assert.equal(existsSync(lock), true)
})

test('backup: ротация оставляет последние 10 копий', (t) => {
  const dir = tempDir(t)
  const dbPath = join(dir, 'board.db')
  const db = openDb(dbPath)

  try {
    for (let i = 0; i < 12; i++) {
      writeFileSync(join(dir, `board.db.bak-2020010${String(i).padStart(2, '0')}-000000`), 'x')
    }

    backupDatabase(db, dbPath)

    const backups = readdirSync(dir).filter((name) => name.startsWith('board.db.bak-'))
    assert.equal(backups.length, 10)
  } finally {
    db.close()
  }
})
