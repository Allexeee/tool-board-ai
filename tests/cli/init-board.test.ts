import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
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

  const data = JSON.parse(result.stdout) as { boardVersion: string }
  assert.equal(data.boardVersion, '1.1.0')
  assert.equal(currentBoardVersion(repo.root), '1.1.0')
  assert.ok(existsSync(join(repo.root, 'tools', 'board', 'bin', 'board.ts')))
  assert.ok(existsSync(join(repo.root, '.opencode', 'plugins', 'board', 'index.ts')))
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
