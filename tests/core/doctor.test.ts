import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { seedCard, seedExecutor, seedRun } from '../helpers/board.ts'
import { makeRepo } from '../helpers/repo.ts'
import { getCard } from '../../src/core/cards.ts'
import { openDb } from '../../src/core/db.ts'
import { doctorData } from '../../src/core/doctor.ts'
import { ensureWorktree, runGit } from '../../src/core/git.ts'
import { initProject } from '../../src/core/project.ts'

/** Репозиторий (main+dev) с настроенной доской: `.board/board.db` и владелец. */
function makeBoardRepo() {
  const repo = makeRepo()
  initProject(repo.root)
  const db = openDb(join(repo.root, '.board', 'board.db'))
  return {
    root: repo.root,
    db,
    close() {
      db.close()
      repo.close()
    },
  }
}

test('doctorData: чистая доска без ошибок и предупреждений', () => {
  const board = makeBoardRepo()
  try {
    const data = doctorData(board.db, board.root)
    assert.deepEqual(data.errors, [])
    assert.deepEqual(data.warnings, [])
  } finally {
    board.close()
  }
})

test('doctorData: советует superpowers, когда его нет в конфиге', (t) => {
  const board = makeBoardRepo()
  const home = mkdtempSync(join(tmpdir(), 'board-home-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  try {
    const without = doctorData(board.db, board.root, home)
    assert.ok(
      without.recommendations.some((item) => item.includes('superpowers')),
      without.recommendations.join(' | '),
    )

    mkdirSync(join(board.root, '.opencode'), { recursive: true })
    writeFileSync(
      join(board.root, '.opencode', 'opencode.json'),
      JSON.stringify({ plugins: ['superpowers'] }),
      'utf8',
    )
    assert.deepEqual(doctorData(board.db, board.root, home).recommendations, [])
  } finally {
    board.close()
  }
})

test('doctorData: предупреждения о lease, ревью, dev и критических находках', () => {
  const board = makeBoardRepo()
  try {
    seedExecutor(board.db, { id: 'developer', skills: ['dev'] })
    // истёкший lease забега
    seedRun(board.db, {
      executorId: 'developer',
      leaseUntil: new Date(Date.now() - 60_000).toISOString(),
    })
    // карточка на ревью
    seedCard(board.db, { phase: 'task', status: 'review' })
    // код уже в dev, но карточка не done
    seedCard(board.db, { phase: 'task', status: 'review', inDev: true })
    // открытая критическая находка
    const critical = seedCard(board.db, { phase: 'request', status: 'new' })
    board.db.prepare("update cards set severity = 'critical' where id = ?").run(critical.id)

    const data = doctorData(board.db, board.root)
    assert.deepEqual(data.errors, [])
    const all = data.warnings.join(' | ')
    assert.ok(data.warnings.some((w) => w.includes('lease')), all)
    assert.ok(data.warnings.some((w) => w.includes('dev')), all)
    assert.ok(data.warnings.some((w) => w.includes('critical')), all)
    assert.ok(data.warnings.some((w) => w.includes('ревью')), all)
  } finally {
    board.close()
  }
})

test('doctorData: грязный worktree — предупреждение', () => {
  const board = makeBoardRepo()
  try {
    const wt = ensureWorktree(board.root, 'developer')
    writeFileSync(join(wt, 'dirty.txt'), 'x')
    const data = doctorData(board.db, board.root)
    assert.deepEqual(data.errors, [])
    assert.ok(data.warnings.some((w) => w.includes('worktree') && w.includes('грязн')), data.warnings.join(' | '))
  } finally {
    board.close()
  }
})

test('doctorData: зарегистрированный, но отсутствующий worktree — предупреждение', () => {
  const board = makeBoardRepo()
  try {
    const wt = ensureWorktree(board.root, 'developer')
    rmSync(wt, { recursive: true, force: true })
    const data = doctorData(board.db, board.root)
    assert.deepEqual(data.errors, [])
    assert.ok(data.warnings.some((w) => w.includes('worktree') && w.includes('каталога нет')), data.warnings.join(' | '))
  } finally {
    board.close()
  }
})

test('doctorData: обновляет in_dev из git по merge_commit', () => {
  const board = makeBoardRepo()
  try {
    const head = runGit(board.root, ['rev-parse', 'dev'])
    const card = seedCard(board.db, { phase: 'task', status: 'review' })
    board.db.prepare('update cards set merge_commit = ? where id = ?').run(head, card.id)

    doctorData(board.db, board.root)

    assert.equal(getCard(board.db, card.id)!.inDev, true)
  } finally {
    board.close()
  }
})

test('doctorData: не git-репозиторий — ошибка', () => {
  const root = mkdtempSync(join(tmpdir(), 'board-nogit-'))
  initProject(root)
  const db = openDb(join(root, '.board', 'board.db'))
  try {
    const data = doctorData(db, root)
    assert.ok(data.errors.some((e) => /git|репозиторий/.test(e)), data.errors.join(' | '))
  } finally {
    db.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('doctorData: нет владельца — ошибка', () => {
  const board = makeBoardRepo()
  try {
    board.db.prepare("delete from executors where id = 'owner'").run()
    const data = doctorData(board.db, board.root)
    assert.ok(data.errors.some((e) => e.includes('owner')), data.errors.join(' | '))
  } finally {
    board.close()
  }
})

test('doctorData: нет ветки dev — ошибка', () => {
  const board = makeBoardRepo()
  try {
    runGit(board.root, ['branch', '-D', 'dev'])
    const data = doctorData(board.db, board.root)
    assert.ok(data.errors.some((e) => e.includes('dev')), data.errors.join(' | '))
  } finally {
    board.close()
  }
})

test('doctorData: новее схема — ошибка', () => {
  const board = makeBoardRepo()
  try {
    board.db.prepare("update meta set value = '99' where key = 'schemaVersion'").run()
    const data = doctorData(board.db, board.root)
    assert.ok(data.errors.some((e) => e.includes('схем')), data.errors.join(' | '))
  } finally {
    board.close()
  }
})

test('doctorData: устаревшая схема (пустая база) — ошибка без запросов к таблицам', () => {
  const root = mkdtempSync(join(tmpdir(), 'board-old-schema-'))
  const db = openDb(':memory:', { allowOutdated: true })
  try {
    const data = doctorData(db, root)
    assert.ok(data.errors.some((e) => e.includes('схема 0')), data.errors.join(' | '))
  } finally {
    db.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('doctorData: нет .board/board.db — ошибка', () => {
  const root = mkdtempSync(join(tmpdir(), 'board-nodb-'))
  const db = openDb(':memory:')
  try {
    const data = doctorData(db, root)
    assert.ok(data.errors.some((e) => e.includes('.board/board.db')), data.errors.join(' | '))
  } finally {
    db.close()
    rmSync(root, { recursive: true, force: true })
  }
})
