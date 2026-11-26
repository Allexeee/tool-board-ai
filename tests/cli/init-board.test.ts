import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { currentBoardVersion } from '../../src/core/git.ts'
import { makeBoardSource, makeRepo } from '../helpers/repo.ts'

const bin = resolve('bin/board.ts')

function run(dir: string, args: string[]) {
  return spawnSync(process.execPath, [bin, ...args], {
    cwd: dir,
    encoding: 'utf8',
    windowsHide: true,
  })
}

/** Обходит локальный CLI: в тесте он заглушка без «Что нового». */
function runGlobal(dir: string, args: string[]) {
  return spawnSync(process.execPath, [bin, ...args], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, BOARD_ALLOW_GLOBAL: '1' },
    windowsHide: true,
  })
}

test('init в git-проекте ставит submodule и генерирует .opencode', (t) => {
  const repo = makeRepo()
  t.after(repo.close)
  const source = makeBoardSource()
  t.after(source.close)

  const result = run(repo.root, [
    'init',
    '--board-version',
    'v1.1.0',
    '--board-source',
    source.source,
    '--json',
  ])
  assert.equal(result.status, 0, result.stderr || result.stdout)

  const data = JSON.parse(result.stdout) as {
    boardVersion: string
    from: string | null
    to: string | null
    whatsNew: Array<{ version: string; points: string[] }>
    proposal: unknown
    proposalWarning: string | null
    recommendations: string[]
  }
  assert.equal(data.boardVersion, '1.1.0')
  assert.equal(data.from, null)
  assert.equal(data.to, '1.1.0')
  assert.deepEqual(data.whatsNew.map((entry) => entry.version), ['1.0.0', '1.1.0'])
  assert.equal(data.proposal, null)
  assert.match(data.proposalWarning ?? '', /не совместима/)
  assert.ok(data.recommendations.includes(data.proposalWarning!))
  assert.equal(currentBoardVersion(repo.root), '1.1.0')
  assert.ok(existsSync(join(repo.root, 'tools', 'board', 'bin', 'board.ts')))
  assert.ok(existsSync(join(repo.root, '.opencode', 'plugins', 'board', 'index.ts')))
})

test('init --refresh не повторяет уже показанное «Что нового»', (t) => {
  const repo = makeRepo()
  t.after(repo.close)
  const source = makeBoardSource()
  t.after(source.close)

  const first = run(repo.root, [
    'init', '--board-version', 'v1.1.0', '--board-source', source.source, '--json',
  ])
  assert.equal(first.status, 0, first.stderr || first.stdout)

  const refreshed = runGlobal(repo.root, ['init', '--refresh', '--json'])
  assert.equal(refreshed.status, 0, refreshed.stderr || refreshed.stdout)
  const data = JSON.parse(refreshed.stdout) as {
    from: string | null
    to: string | null
    whatsNew: Array<{ version: string }>
  }
  assert.equal(data.from, '1.1.0')
  assert.equal(data.to, '1.1.0')
  assert.deepEqual(data.whatsNew, [])

  const text = runGlobal(repo.root, ['init', '--refresh'])
  assert.equal(text.status, 0, text.stderr || text.stdout)
  assert.match(text.stdout, /Что нового: изменений нет\./)
})

test('init в репозитории board не добавляет submodule', (t) => {
  const repo = makeRepo()
  t.after(repo.close)

  mkdirSync(join(repo.root, 'bin'), { recursive: true })
  mkdirSync(join(repo.root, 'src', 'core'), { recursive: true })
  writeFileSync(join(repo.root, 'package.json'), JSON.stringify({ name: 'tool-board-ai' }))
  writeFileSync(join(repo.root, 'bin', 'board.ts'), '')
  writeFileSync(join(repo.root, 'src', 'core', 'now.ts'), '')

  const result = run(repo.root, ['init', '--json'])
  assert.equal(result.status, 0, result.stderr || result.stdout)
  assert.equal(existsSync(join(repo.root, 'tools', 'board')), false)
})

test('init ремонтирует submodule без bin/board.ts', (t) => {
  const repo = makeRepo()
  t.after(repo.close)
  const boardSource = makeBoardSource()
  t.after(boardSource.close)

  const init = run(repo.root, [
    'init', '--board-version', 'v1.1.0', '--board-source', boardSource.source, '--json',
  ])
  assert.equal(init.status, 0, init.stderr || init.stdout)

  const sub = join(repo.root, 'tools', 'board')
  execFileSync('git', ['rm', 'bin/board.ts'], { cwd: sub, windowsHide: true })
  execFileSync(
    'git',
    ['-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'commit', '-m', 'missing cli'],
    { cwd: sub, windowsHide: true },
  )

  const repaired = run(repo.root, ['init', '--json'])
  assert.equal(repaired.status, 0, repaired.stderr || repaired.stdout)
  assert.ok(existsSync(join(sub, 'bin', 'board.ts')))
})

test('init читает BOARD_SOURCE', (t) => {
  const repo = makeRepo()
  t.after(repo.close)
  const source = makeBoardSource()
  t.after(source.close)

  const previous = process.env.BOARD_SOURCE
  process.env.BOARD_SOURCE = source.source
  try {
    const result = run(repo.root, ['init', '--board-version', 'v1.0.0', '--json'])
    assert.equal(result.status, 0, result.stderr || result.stdout)
    assert.equal(currentBoardVersion(repo.root), '1.0.0')
  } finally {
    if (previous === undefined) delete process.env.BOARD_SOURCE
    else process.env.BOARD_SOURCE = previous
  }
})
