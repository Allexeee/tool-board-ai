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

test('group rename без коллизий сохраняет номера', (t) => {
  const dir = project(t)
  run(dir, ['card', 'add', '--group', 'SEO', '--title', 'a', '--skill', 'dev'])
  run(dir, ['card', 'add', '--group', 'SEO', '--title', 'b', '--skill', 'dev'])

  const renamed = run(dir, ['group', 'rename', 'SEO', 'NEWSITE', '--json'])
  assert.equal(renamed.code, 0, renamed.err)
  const result = JSON.parse(renamed.out) as { cards: Array<{ from: string; to: string }> }
  assert.deepEqual(result.cards, [
    { from: 'SEO-1', to: 'NEWSITE-1' },
    { from: 'SEO-2', to: 'NEWSITE-2' },
  ])
})

test('group rename --merge: коллизия выдаёт новый номер и сохраняет старый ID', (t) => {
  const dir = project(t)
  run(dir, ['card', 'add', '--group', 'SEO', '--title', 'SEO', '--skill', 'dev'])
  run(dir, ['card', 'add', '--group', 'SITE', '--new-group', '--title', 'SITE', '--skill', 'dev'])

  const dry = run(dir, ['group', 'rename', 'SEO', 'SITE', '--merge', '--dry-run', '--json'])
  assert.equal(dry.code, 0, dry.err)
  const planned = JSON.parse(dry.out) as { cards: Array<{ from: string; to: string }> }
  assert.deepEqual(planned.cards, [{ from: 'SEO-1', to: 'SITE-2' }])

  const renamed = run(dir, ['group', 'rename', 'SEO', 'SITE', '--merge', '--json'])
  assert.equal(renamed.code, 0, renamed.err)

  const groups = JSON.parse(run(dir, ['group', 'list', '--json']).out) as Array<{
    prefix: string
    count: number
  }>
  assert.deepEqual(groups.map((group) => [group.prefix, group.count]), [['SITE', 2]])

  const shown = run(dir, ['card', 'show', 'SEO-1', '--json'])
  assert.equal(shown.code, 0, shown.err)
  assert.equal((JSON.parse(shown.out) as { id: string }).id, 'SITE-2')
})

test('group rename в существующую без --merge — ошибка', (t) => {
  const dir = project(t)
  run(dir, ['card', 'add', '--group', 'SEO', '--title', 'SEO', '--skill', 'dev'])
  run(dir, ['card', 'add', '--group', 'SITE', '--new-group', '--title', 'SITE', '--skill', 'dev'])

  const result = run(dir, ['group', 'rename', 'SEO', 'SITE'])
  assert.equal(result.code, 3)
  assert.match(result.err, /--merge/)
})
