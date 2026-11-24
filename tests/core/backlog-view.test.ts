import test from 'node:test'
import assert from 'node:assert/strict'
import { buildBacklog } from '../../src/core/backlog.ts'
import { renderBacklogPage } from '../../src/core/backlog-view.ts'
import { makeBoard, seedCard } from '../helpers/board.ts'

test('buildBacklog: группы по навыку и человеческие статусы', (t) => {
  const board = makeBoard()
  t.after(board.close)

  seedCard(board.db, { phase: 'task', status: 'ready', skill: 'dev' })
  seedCard(board.db, { phase: 'task', status: 'shaping', skill: 'owner' })

  const data = buildBacklog(board.db)
  assert.deepEqual(
    data.skills.map((section) => section.label),
    ['владельца', 'dev'],
  )
  assert.equal(data.skills[1].rows[0].status, 'готов к работе')
  assert.equal(data.skills[0].rows[0].status, 'разбор')
})

test('renderBacklogPage: статический HTML в тёмной теме для F5', (t) => {
  const board = makeBoard()
  t.after(board.close)
  seedCard(board.db, { phase: 'task', status: 'ready', skill: 'dev' })

  const html = renderBacklogPage(buildBacklog(board.db))
  assert.match(html, /<html lang="ru">/)
  assert.match(html, /--bg: #0f0f10/)
  assert.match(html, /готов к работе/)
  assert.match(html, /F5/)
  assert.doesNotMatch(html, /fetch\(/)
  assert.doesNotMatch(html, /setInterval/)
})
