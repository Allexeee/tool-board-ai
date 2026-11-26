import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
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

function json(dir: string, args: string[]) {
  const result = run(dir, [...args, '--json'])
  assert.equal(result.code, 0, result.err)
  return JSON.parse(result.out)
}

test('tag add/list/rename/remove через CLI', (t) => {
  const board = makeBoard()
  t.after(board.close)

  const added = json(board.root, ['tag', 'add', 'UI', '--description', 'интерфейс'])
  assert.equal(added.name, 'ui')

  const listed = json(board.root, ['tag', 'list'])
  assert.ok(listed.some((item: { name: string }) => item.name === 'ui'))

  const renamed = json(board.root, ['tag', 'rename', 'ui', 'interface'])
  assert.equal(renamed.name, 'interface')

  const removed = json(board.root, ['tag', 'remove', 'interface'])
  assert.equal(removed.name, 'interface')
})

test('card shape --tag и card tag add/remove/list', (t) => {
  const board = makeBoard()
  t.after(board.close)
  run(board.root, ['tag', 'add', 'ui'])

  const card = json(board.root, [
    'card', 'add', '--group', 'UI', '--title', 't', '--skill', 'dev',
  ])
  const shaped = json(board.root, [
    'card', 'shape', card.id, '--as', 'developer', '--tag', 'ui',
  ])
  assert.deepEqual(shaped.tags, ['ui'])

  const added = json(board.root, ['card', 'tag', 'add', card.id, 'review'])
  assert.deepEqual(added.tags, ['ui', 'review'])

  const listed = json(board.root, ['card', 'tag', 'list', card.id])
  assert.deepEqual(listed, ['ui', 'review'])

  const removed = json(board.root, ['card', 'tag', 'remove', card.id, 'review'])
  assert.deepEqual(removed.tags, ['ui'])
})
