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

test('idea add/list/edit/drop через CLI', (t) => {
  const board = makeBoard()
  t.after(board.close)

  const added = run(board.root, ['idea', 'add', 'Тёмная тема', '--json'])
  assert.equal(added.code, 0, added.err)
  const idea = JSON.parse(added.out) as {
    id: string
    status: string
    body: string
    tags: string[]
    needsMerge: boolean
  }
  assert.equal(idea.status, 'deferred')
  assert.equal(idea.body, 'Тёмная тема')
  assert.deepEqual(idea.tags, ['idea'])
  assert.equal(idea.needsMerge, false)

  const listed = run(board.root, ['idea', 'list', '--json'])
  assert.equal(listed.code, 0, listed.err)
  assert.deepEqual(
    (JSON.parse(listed.out) as Array<{ id: string }>).map((item) => item.id),
    [idea.id],
  )

  const edited = run(board.root, ['idea', 'edit', idea.id, '--text', 'Светлая тема', '--json'])
  assert.equal(edited.code, 0, edited.err)
  assert.equal((JSON.parse(edited.out) as { body: string }).body, 'Светлая тема')

  const dropped = run(board.root, ['idea', 'drop', idea.id, '--json'])
  assert.equal(dropped.code, 0, dropped.err)
  assert.equal((JSON.parse(dropped.out) as { status: string }).status, 'cancelled')

  const empty = run(board.root, ['idea', 'list', '--json'])
  assert.deepEqual(JSON.parse(empty.out), [])
})

test('idea add без текста — ошибка ввода', (t) => {
  const board = makeBoard()
  t.after(board.close)

  const result = run(board.root, ['idea', 'add'])
  assert.equal(result.code, 3)
  assert.match(result.err, /текст идеи/)
})
