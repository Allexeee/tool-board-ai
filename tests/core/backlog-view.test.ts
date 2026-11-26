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

test('renderBacklogPage: цвета статусов остаются, легенды нет', (t) => {
  const board = makeBoard()
  t.after(board.close)
  seedCard(board.db, { phase: 'task', status: 'ready', skill: 'dev' })
  seedCard(board.db, { phase: 'task', status: 'review', skill: 'dev' })
  seedCard(board.db, { phase: 'task', status: 'acceptance', skill: 'dev' })

  const html = renderBacklogPage(buildBacklog(board.db))
  assert.doesNotMatch(html, /class="legend"/)
  assert.doesNotMatch(html, /legend-item/)
  assert.match(html, /class="status-ready"/)
  assert.match(html, /class="status-review"/)
  assert.match(html, /class="status-acceptance"/)
  assert.match(html, /tr\.status-ready/)
  assert.match(html, /tr\.status-booked \{ --row: #34d399; \}/)
  assert.match(html, /tr\.status-done \{ --row: #16a34a; \}/)
})

test('неизвестный статус не ломает бэклог', (t) => {
  const board = makeBoard()
  t.after(board.close)
  const card = seedCard(board.db, { phase: 'task', status: 'ready', skill: 'dev' })
  board.db.prepare("update cards set status = 'weird' where id = ?").run(card.id)

  const data = buildBacklog(board.db)
  const row = data.skills.flatMap((section) => section.rows).find((item) => item.id === card.id)
  assert.equal(row?.status, 'weird')
  assert.doesNotThrow(() => renderBacklogPage(data))
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

test('renderBacklogPage: идеи в конце отдельной таблицей и коротким заголовком', (t) => {
  const board = makeBoard()
  t.after(board.close)
  addIdea(board.db, {
    text: 'Короткая идея\nОчень длинное описание, которое не должно попасть в HTML.',
    title: 'feat: Короткая идея',
    actor: 'owner',
  })

  const html = renderBacklogPage(buildBacklog(board.db))
  assert.match(html, /<h2>Идеи<\/h2>/)
  assert.match(html, /Короткая идея/)
  assert.doesNotMatch(html, /feat: Короткая идея/)
  assert.doesNotMatch(html, /Очень длинное описание/)
  assert.match(html, /class="idea-text"><div class="clamp2">/)
  assert.ok(html.indexOf('Короткая идея') > html.indexOf('Бэклог'))
})

test('renderBacklogPage: Отложенные свёрнуты, причина короткая', (t) => {
  const board = makeBoard()
  t.after(board.close)
  const card = seedCard(board.db, { phase: 'task', status: 'deferred', skill: 'dev' })
  board.db
    .prepare('update cards set note = ? where id = ?')
    .run('Первая фраза. Вторая фраза, которая не должна попасть в колонку причины.', card.id)

  const data = buildBacklog(board.db)
  assert.equal(data.deferred[0].reason, 'Первая фраза.')
  assert.match(data.deferred[0].note, /Вторая фраза/)

  const html = renderBacklogPage(data)
  assert.match(html, /<details id="deferred">/)
  assert.match(html, /<summary>Отложенные \(1\)<\/summary>/)
  assert.match(html, /class="note reason"><div class="clamp2">Первая фраза\.<\/div>/)
  assert.match(html, /board-deferred-open/)
  assert.match(html, /details:not\(\[open\]\) > table/)
  assert.doesNotMatch(html, /Вторая фраза/)
})

test('renderBacklogPage: Inter, размеры, ширина и zoom', (t) => {
  const board = makeBoard()
  t.after(board.close)
  seedCard(board.db, { phase: 'task', status: 'ready', skill: 'dev' })

  const html = renderBacklogPage(buildBacklog(board.db))
  assert.match(html, /@font-face/)
  assert.match(html, /src: url\("Inter\.ttf"\) format\("truetype"\)/)
  assert.match(html, /font: 16px\/1\.6 "Inter"/)
  assert.match(html, /html \{ zoom: 0\.8; \}/)
  assert.match(html, /max-width: 1440px/)
  assert.match(html, /"IBM Plex Mono"/)
  assert.match(html, /td\.id \{[^}]*font-size: 20px/)
  assert.match(html, /-webkit-line-clamp: 2/)
  assert.doesNotMatch(html, /table-layout\s*:/)
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
  assert.match(html, /meta name="board-revision"/)
  assert.match(html, /fetch\(location\.href, \{ cache: 'no-store' \}\)/)
  assert.match(html, /DOMParser/)
  assert.match(html, /replaceWith\(document\.importNode/)
  const interval = html.slice(html.lastIndexOf('setInterval('))
  assert.match(interval, /window\.boardRefresh\(\)/)
  assert.doesNotMatch(interval, /location\.reload/)

  const staticHtml = renderBacklogPage(buildBacklog(board.db), 0)
  assert.doesNotMatch(staticHtml, /setInterval\(/)
  assert.match(staticHtml, /boardReload/)
  assert.match(staticHtml, /Обновить/)
  assert.match(staticHtml, /F5/)
})
