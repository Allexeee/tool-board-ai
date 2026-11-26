import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { makeBoard, seedCard } from '../helpers/board.ts'

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

test('acceptance rule и owner-acceptance в card add/edit', (t) => {
  const board = makeBoard()
  t.after(board.close)
  assert.equal(run(board.root, ['tag', 'add', 'ui']).code, 0)

  const rule = json(board.root, [
    'acceptance', 'rule', 'add', 'visual', '--include-tag', 'ui',
  ])
  assert.equal(rule.name, 'visual')

  const card = json(board.root, [
    'card', 'add', '--group', 'UI', '--title', 'кнопка', '--skill', 'dev', '--tag', 'ui',
  ])
  assert.equal(card.ownerAcceptance, true)

  const checked = json(board.root, ['acceptance', 'check', card.id])
  assert.equal(checked.required, true)
  assert.deepEqual(checked.matched, ['visual'])

  const manual = json(board.root, ['card', 'edit', card.id, '--no-owner-acceptance'])
  assert.equal(manual.ownerAcceptance, false)
  assert.equal(manual.ownerAcceptanceManual, true)

  const after = json(board.root, ['acceptance', 'check', card.id])
  assert.equal(after.required, false)
  assert.equal(after.manual, true)

  const shown = run(board.root, ['card', 'show', card.id])
  assert.match(shown.out, /приёмка владельца: нет \(вручную\)/)
})

test('card accept и reject через CLI', (t) => {
  const board = makeBoard()
  t.after(board.close)
  const first = seedCard(board.db, { phase: 'task', status: 'acceptance' })
  const accepted = json(board.root, ['card', 'accept', first.id, '--as', 'owner'])
  assert.equal(accepted.status, 'done')

  const second = seedCard(board.db, { phase: 'task', status: 'acceptance' })
  board.db
    .prepare("update cards set previous_holder = 'developer' where id = ?")
    .run(second.id)
  const rejected = json(board.root, [
    'card', 'accept', second.id, '--reject', '--reason', 'не то', '--as', 'owner',
  ])
  assert.equal(rejected.status, 'in_progress')

  const noReason = run(board.root, [
    'card', 'accept', second.id, '--reject', '--as', 'owner',
  ])
  assert.equal(noReason.code, 3)
})

test('acceptance rule list/remove', (t) => {
  const board = makeBoard()
  t.after(board.close)
  run(board.root, ['tag', 'add', 'ui'])
  run(board.root, ['acceptance', 'rule', 'add', 'visual', '--include-tag', 'ui'])

  const listed = json(board.root, ['acceptance', 'rule', 'list'])
  assert.equal(listed[0].name, 'visual')

  const removed = json(board.root, ['acceptance', 'rule', 'remove', 'visual'])
  assert.equal(removed.name, 'visual')
  assert.deepEqual(json(board.root, ['acceptance', 'rule', 'list']), [])
})
