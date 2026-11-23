import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { backupBeforeMigration } from '../../src/core/backup.ts'
import { openDb } from '../../src/core/db.ts'
import { makeBoard } from '../helpers/board.ts'

const bin = resolve('bin/board.ts')

function run(dir: string, args: string[]) {
  const result = spawnSync(process.execPath, [bin, ...args], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, BOARD_ALLOW_GLOBAL: '1' },
    windowsHide: true,
  })
  return { code: result.status, out: result.stdout ?? '', err: result.stderr ?? '' }
}

function project(t: { after: (fn: () => void) => void }): string {
  const dir = mkdtempSync(join(tmpdir(), 'board-backup-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const init = run(dir, ['init'])
  assert.equal(init.code, 0, init.err)
  return dir
}

function json(dir: string, args: string[]) {
  const result = run(dir, [...args, '--json'])
  assert.equal(result.code, 0, result.err)
  return JSON.parse(result.out)
}

test('board backup делает читаемую копию базы', (t) => {
  const dir = project(t)
  json(dir, ['card', 'add', '--group', 'UI', '--title', 'Форма', '--skill', 'dev'])

  const backup = json(dir, ['backup']) as { path: string }
  assert.ok(existsSync(backup.path))

  const db = openDb(backup.path)
  try {
    const cards = db.prepare('select id, title from cards').all()
    assert.equal(cards.length, 1)
  } finally {
    db.close()
  }
})

test('backupBeforeMigration кладёт копию рядом с базой', (t) => {
  const fixture = makeBoard()
  t.after(fixture.close)
  const dbPath = join(fixture.root, '.board', 'board.db')

  const path = backupBeforeMigration(fixture.db, dbPath)
  assert.ok(path)
  assert.ok(existsSync(path!))
  assert.ok(readdirSync(join(fixture.root, '.board')).some((name) => name.includes('.bak-')))
})

test('board export отдаёт json и markdown', (t) => {
  const dir = project(t)
  json(dir, [
    'card', 'add', '--group', 'UI', '--title', 'Форма', '--skill', 'dev',
    '--spec', 'Спека', '--acceptance', 'Работает',
  ])

  const exported = json(dir, ['export']) as { cards: Array<{ id: string; acceptance: string }> }
  assert.equal(exported.cards[0].id, 'UI-1')
  assert.equal(exported.cards[0].acceptance, 'Работает')

  const outFile = join(dir, 'board.md')
  const md = run(dir, ['export', '--md', '--out', outFile])
  assert.equal(md.code, 0, md.err)
  const text = readFileSync(outFile, 'utf8')
  assert.match(text, /# Доска/)
  assert.match(text, /UI-1 — Форма/)
  assert.match(text, /- \[ \] Работает/)
})
