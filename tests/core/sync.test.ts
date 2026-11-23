import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { listCards, createCard } from '../../src/core/cards.ts'
import { openDb } from '../../src/core/db.ts'
import { initProject } from '../../src/core/project.ts'
import { syncPull, syncPush } from '../../src/core/sync.ts'
import { makeRepo } from '../helpers/repo.ts'

function bareRepo(dir: string): string {
  const path = join(dir, 'data.git')
  execFileSync('git', ['init', '--bare', path], { stdio: 'ignore', windowsHide: true })
  return path
}

test('sync: push копирует базу в приватный git, pull забирает её', (t) => {
  const base = mkdtempSync(join(tmpdir(), 'board-sync-'))
  t.after(() => rmSync(base, { recursive: true, force: true }))
  const remote = bareRepo(base)

  const first = makeRepo()
  t.after(() => first.close())
  initProject(first.root)
  const firstDbPath = join(first.root, '.board', 'board.db')
  const db = openDb(firstDbPath)
  createCard(db, { group: 'CNT', title: 'текст', skill: 'dev', author: 'owner' })
  db.exec('pragma wal_checkpoint(truncate)')
  db.close()

  syncPush(first.root, firstDbPath, remote)

  const second = makeRepo()
  t.after(() => second.close())
  initProject(second.root)
  const secondDbPath = join(second.root, '.board', 'board.db')
  const emptyDb = openDb(secondDbPath)
  assert.equal(listCards(emptyDb).length, 0)
  emptyDb.close()

  const result = syncPull(second.root, secondDbPath, remote)
  assert.ok(result.backup !== null)

  const pulled = openDb(secondDbPath)
  try {
    assert.equal(listCards(pulled).length, 1)
  } finally {
    pulled.close()
  }
})

test('sync: без remote — понятная ошибка', (t) => {
  const repo = makeRepo()
  t.after(() => repo.close())
  initProject(repo.root)

  assert.throws(
    () => syncPush(repo.root, join(repo.root, '.board', 'board.db'), null),
    /sync не настроен/,
  )
})
