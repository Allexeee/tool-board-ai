import test from 'node:test'
import assert from 'node:assert/strict'
import { buildBacklog } from '../../src/core/backlog.ts'
import { addIdea } from '../../src/core/cards.ts'
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
  assert.equal(data.skills[1].rows[0].status, 'в очереди')
  assert.equal(data.skills[0].rows[0].status, 'разбор')
})

test('renderBacklogPage: цвета статусов и легенда', (t) => {
  const board = makeBoard()
  t.after(board.close)
  seedCard(board.db, { phase: 'task', status: 'ready', skill: 'dev' })
  seedCard(board.db, { phase: 'task', status: 'review', skill: 'dev' })
  seedCard(board.db, { phase: 'task', status: 'acceptance', skill: 'dev' })

  const html = renderBacklogPage(buildBacklog(board.db))
  assert.match(html, /class="legend"/)
  assert.match(html, /dot status-ready/)
  assert.match(html, /class="status-ready"/)
  assert.match(html, /class="status-review"/)
  assert.match(html, /class="status-acceptance"/)
  assert.match(html, /tr\.status-ready/)
})

test('buildBacklog: waiting и blocked после доступных', (t) => {
  const board = makeBoard()
  t.after(board.close)
  const ready = seedCard(board.db, {
    phase: 'task',
    status: 'ready',
    skill: 'dev',
    importance: 0,
    urgency: 0,
  })
  const waiting = seedCard(board.db, {
    phase: 'task',
    status: 'waiting',
    skill: 'dev',
    importance: 3,
    urgency: 3,
  })

  const section = buildBacklog(board.db).skills.find((item) => item.skill === 'dev')
  assert.ok(section)
  assert.equal(section.rows[0].id, ready.id)
  assert.equal(section.rows[1].id, waiting.id)
})

test('renderBacklogPage: идеи в конце отдельной таблицей', (t) => {
  const board = makeBoard()
  t.after(board.close)
  addIdea(board.db, { text: 'Идея в html', actor: 'owner' })

  const html = renderBacklogPage(buildBacklog(board.db))
  assert.match(html, /<h2>Идеи<\/h2>/)
  assert.match(html, /Идея в html/)
  assert.ok(html.indexOf('Идея в html') > html.indexOf('Бэклог'))
})

test('renderBacklogPage: автообновление, кнопка и крупный шрифт', (t) => {
  const board = makeBoard()
  t.after(board.close)
  seedCard(board.db, { phase: 'task', status: 'ready', skill: 'dev' })

  const html = renderBacklogPage(buildBacklog(board.db))
  assert.match(html, /<html lang="ru">/)
  assert.match(html, /--bg: #0f0f10/)
  assert.match(html, /font: 16px\/1\.6/)
  assert.match(html, /в очереди/)
  assert.match(html, /location\.reload\(\)/)
  assert.match(html, /sessionStorage/)
  assert.match(html, /setInterval\(/)
  assert.match(html, /boardReload/)
  assert.match(html, /Обновить/)
  assert.match(html, /авто 5 с/)
  assert.doesNotMatch(html, /fetch\(/)

  const staticHtml = renderBacklogPage(buildBacklog(board.db), 0)
  assert.doesNotMatch(staticHtml, /setInterval\(/)
  assert.match(staticHtml, /boardReload/)
  assert.match(staticHtml, /Обновить/)
  assert.match(staticHtml, /F5/)
})
