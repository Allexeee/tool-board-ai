import test from 'node:test'
import assert from 'node:assert/strict'
import { buildBacklog } from '../../src/core/backlog.ts'
import { renderBacklogHtml } from '../../src/core/backlog-view.ts'
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

test('renderBacklogHtml: тёмная страница с опросом /data.json', () => {
  const html = renderBacklogHtml()
  assert.match(html, /<html lang="ru">/)
  assert.match(html, /--bg: #0f0f10/)
  assert.match(html, /fetch\('\/data\.json'/)
  assert.match(html, /setInterval\(tick, 2000\)/)
  assert.match(html, /Бэклог/)
})
