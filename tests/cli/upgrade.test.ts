import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
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

function runGlobal(dir: string, args: string[]) {
  return spawnSync(process.execPath, [bin, ...args], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, BOARD_ALLOW_GLOBAL: '1' },
    windowsHide: true,
  })
}

test('upgrade переключает submodule и перегенерирует .opencode', (t) => {
  const repo = makeRepo()
  t.after(repo.close)
  const source = makeBoardSource()
  t.after(source.close)

  const init = run(repo.root, [
    'init',
    '--board-version',
    'v1.0.0',
    '--board-source',
    source.source,
    '--json',
  ])
  assert.equal(init.status, 0, init.stderr || init.stdout)
  assert.equal(currentBoardVersion(repo.root), '1.0.0')

  const upgraded = runGlobal(repo.root, ['upgrade', 'v1.1.0', '--json'])
  assert.equal(upgraded.status, 0, upgraded.stderr || upgraded.stdout)
  const data = JSON.parse(upgraded.stdout) as {
    boardVersion: string
    ref: string
    from: string | null
    to: string | null
    whatsNew: Array<{ version: string; points: string[] }>
  }
  assert.equal(data.ref, 'v1.1.0')
  assert.equal(data.boardVersion, '1.1.0')
  assert.equal(data.from, '1.0.0')
  assert.equal(data.to, '1.1.0')
  assert.deepEqual(data.whatsNew.map((entry) => entry.version), ['1.1.0'])
  assert.deepEqual(data.whatsNew[0].points, ['Новая возможность.', 'Второй пункт.'])
  assert.equal(currentBoardVersion(repo.root), '1.1.0')
})

test('upgrade в терминале печатает «Что нового» человеческим языком', (t) => {
  const repo = makeRepo()
  t.after(repo.close)
  const source = makeBoardSource()
  t.after(source.close)

  const init = run(repo.root, [
    'init', '--board-version', 'v1.0.0', '--board-source', source.source, '--json',
  ])
  assert.equal(init.status, 0, init.stderr || init.stdout)

  const upgraded = runGlobal(repo.root, ['upgrade', 'v1.1.0'])
  assert.equal(upgraded.status, 0, upgraded.stderr || upgraded.stdout)
  assert.match(upgraded.stdout, /Что нового для вас \(1\.0\.0 → 1\.1\.0\):/)
  assert.match(upgraded.stdout, /• Новая возможность\./)
  assert.match(upgraded.stdout, /• Второй пункт\./)
})

test('upgrade на грязном submodule отказывает', (t) => {
  const repo = makeRepo()
  t.after(repo.close)
  const source = makeBoardSource()
  t.after(source.close)

  const init = run(repo.root, [
    'init',
    '--board-version',
    'v1.0.0',
    '--board-source',
    source.source,
    '--json',
  ])
  assert.equal(init.status, 0, init.stderr || init.stdout)

  writeFileSync(join(repo.root, 'tools', 'board', 'dirty.txt'), 'x')
  const upgraded = runGlobal(repo.root, ['upgrade', 'v1.1.0'])
  assert.equal(upgraded.status, 2)
  assert.match(upgraded.stderr, /грязн/)
})
