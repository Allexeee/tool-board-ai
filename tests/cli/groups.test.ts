import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const bin = resolve('bin/board.ts')

function run(dir: string, args: string[]) {
  const result = spawnSync(process.execPath, [bin, ...args], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, BOARD_ALLOW_GLOBAL: '1' },
    windowsHide: true,
  })
  return { code: result.status, out: result.stdout, err: result.stderr }
}

function project(t: { after: (fn: () => void) => void }): string {
  const dir = mkdtempSync(join(tmpdir(), 'board-group-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  assert.equal(run(dir, ['init']).code, 0)
  return dir
}

test('group list: в новом проекте префиксов нет', (t) => {
  const dir = project(t)
  const listed = run(dir, ['group', 'list', '--json'])
  assert.equal(listed.code, 0, listed.err)
  assert.deepEqual(JSON.parse(listed.out), [])
})

test('card add без групп берёт CARD', (t) => {
  const dir = project(t)
  const added = run(dir, ['card', 'add', '--title', 't', '--skill', 'dev', '--json'])
  assert.equal(added.code, 0, added.err)
  assert.equal(JSON.parse(added.out).id, 'CARD-1')
})

test('незнакомый префикс без --new-group — ошибка', (t) => {
  const dir = project(t)
  // Первый префикс в пустом проекте — это определение области.
  assert.equal(run(dir, ['card', 'add', '--group', 'SITE', '--title', 't', '--skill', 'dev']).code, 0)

  const second = run(dir, ['card', 'add', '--group', 'SHOP', '--title', 't', '--skill', 'dev'])
  assert.equal(second.code, 3)
  assert.match(second.err, /--new-group/)
  assert.match(second.err, /SITE/)

  const created = run(dir, ['card', 'add', '--group', 'SHOP', '--title', 't', '--skill', 'dev', '--new-group', '--json'])
  assert.equal(created.code, 0, created.err)

  const groups = JSON.parse(run(dir, ['group', 'list', '--json']).out) as Array<{ prefix: string; count: number }>
  assert.deepEqual(
    groups.map((group) => [group.prefix, group.count]),
    [
      ['SHOP', 1],
      ['SITE', 1],
    ],
  )
})

test('при наличии групп card add без --group — ошибка', (t) => {
  const dir = project(t)
  run(dir, ['card', 'add', '--group', 'SITE', '--title', 't', '--skill', 'dev'])

  const result = run(dir, ['card', 'add', '--title', 't', '--skill', 'dev'])
  assert.equal(result.code, 3)
  assert.match(result.err, /SITE/)
})
