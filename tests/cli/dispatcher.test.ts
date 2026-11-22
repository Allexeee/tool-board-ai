import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { findProjectRootForCli } from '../../src/core/git.ts'
import { makeRepo } from '../helpers/repo.ts'

const bin = resolve('bin/board.ts')

function run(dir: string, args: string[]) {
  return spawnSync(process.execPath, [bin, ...args], {
    cwd: dir,
    encoding: 'utf8',
    windowsHide: true,
  })
}

test('глобальный board делегирует локальному CLI', (t) => {
  const repo = makeRepo()
  t.after(repo.close)
  mkdirSync(join(repo.root, 'tools', 'board', 'bin'), { recursive: true })
  writeFileSync(join(repo.root, 'tools', 'board', 'bin', 'board.ts'), "console.log('LOCAL')\n")

  const out = run(repo.root, ['now'])
  assert.equal(out.status, 0, out.stderr)
  assert.equal(out.stdout.trim(), 'LOCAL')
})

test('--global обходит делегирование', (t) => {
  const repo = makeRepo()
  t.after(repo.close)
  mkdirSync(join(repo.root, 'tools', 'board', 'bin'), { recursive: true })
  writeFileSync(join(repo.root, 'tools', 'board', 'bin', 'board.ts'), "console.log('LOCAL')\n")

  const out = run(repo.root, ['--global', '--version'])
  assert.equal(out.status, 0, out.stderr)
  assert.notEqual(out.stdout.trim(), 'LOCAL')
})

test('без локального CLI операционная команда — код 2', (t) => {
  const repo = makeRepo()
  t.after(repo.close)

  const out = run(repo.root, ['now'])
  assert.equal(out.status, 2)
  assert.match(out.stderr, /board не установлен/)
})

test('findProjectRootForCli поднимается из worktree в корень', (t) => {
  const repo = makeRepo()
  t.after(repo.close)
  const worktree = join(repo.root, '.worktrees', 'owner')
  mkdirSync(worktree, { recursive: true })
  writeFileSync(join(worktree, '.git'), 'gitdir: ../../.git/worktrees/owner\n')

  assert.equal(findProjectRootForCli(worktree), repo.root)
})
