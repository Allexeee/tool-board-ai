import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { installHooks, hookInstalled } from '../../src/core/git/hooks.ts'
import { runGit } from '../../src/core/git/git.ts'
import { makeRepo } from '../helpers/repo.ts'

test('хук ставится и запрещает коммит в защищённую ветку', () => {
  const dir = makeRepo()
  const { installed } = installHooks(join(dir, '.git'), { protectedBranches: ['main', 'dev'] })
  assert.deepEqual(installed, ['pre-commit', 'pre-merge-commit'])
  assert.equal(hookInstalled(join(dir, '.git')), true)
  assert.ok(existsSync(join(dir, '.git/hooks/pre-commit')))
  assert.ok(existsSync(join(dir, '.git/hooks/pre-merge-commit')))

  writeFileSync(join(dir, 'a.txt'), 'x')
  runGit(dir, ['add', 'a.txt'])
  assert.throws(() => runGit(dir, ['commit', '-m', 'x']), /защищённ/)
})

test('merge в защищённую ветку блокируется', () => {
  const dir = makeRepo()
  installHooks(join(dir, '.git'), { protectedBranches: ['main'] })
  runGit(dir, ['checkout', '-q', '-b', 'feature'])
  writeFileSync(join(dir, 'merge.txt'), 'x')
  runGit(dir, ['add', 'merge.txt'])
  runGit(dir, ['commit', '-q', '-m', 'feature'], { AL_ALLOW: '1' })
  runGit(dir, ['checkout', '-q', 'main'])

  assert.throws(
    () => runGit(dir, ['merge', '--no-ff', 'feature', '-m', 'merge']),
    /защищённ/,
  )
})

test('переустановка обновляет список веток', () => {
  const dir = makeRepo()
  installHooks(join(dir, '.git'), { protectedBranches: ['main'] })
  installHooks(join(dir, '.git'), { protectedBranches: ['main', 'develop'] })

  const hook = readFileSync(join(dir, '.git/hooks/pre-commit'), 'utf8')
  assert.match(hook, /develop/)
})

test('init защищает develop, если он есть', () => {
  const dir = makeRepo()
  runGit(dir, ['branch', 'develop'])
  initProject(dir)

  const hook = readFileSync(join(dir, '.git/hooks/pre-commit'), 'utf8')
  assert.match(hook, /develop/)
})

test('AL_ALLOW=1 пропускает коммит', () => {
  const dir = makeRepo()
  installHooks(join(dir, '.git'), { protectedBranches: ['main'] })
  writeFileSync(join(dir, 'b.txt'), 'x')
  runGit(dir, ['add', 'b.txt'])

  runGit(dir, ['commit', '-m', 'ok'], { AL_ALLOW: '1' })
  assert.match(runGit(dir, ['log', '-1', '--pretty=%s']), /ok/)
})

test('повторная установка не плодит дублей', () => {
  const dir = makeRepo()
  installHooks(join(dir, '.git'), { protectedBranches: ['main'] })
  const second = installHooks(join(dir, '.git'), { protectedBranches: ['main'] })
  assert.deepEqual(second.installed, [])
})

import { initProject } from '../../src/core/project.ts'

test('init ставит хук сам', () => {
  const dir = makeRepo()
  initProject(dir)
  assert.equal(hookInstalled(join(dir, '.git')), true)
})

