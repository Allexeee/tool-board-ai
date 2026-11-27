import test from 'node:test'
import assert from 'node:assert/strict'
import { addDep } from '../../src/core/deps.ts'
import { addIdea } from '../../src/core/cards.ts'
import { deferCard } from '../../src/core/lifecycle.ts'
import {
  BACKLOG_FONT_NAME,
  backlogStatePath,
  buildBacklog,
  flushBacklog,
  renderBacklog,
  writeBacklog,
  writeBacklogHtml,
} from '../../src/core/backlog.ts'
import { readSettings, updateSettings } from '../../src/core/settings.ts'
import { moveCard } from '../../src/core/queue.ts'
import { renderBacklogPage } from '../../src/core/backlog-view.ts'
import { makeBoard, seedCard, seedExecutor } from '../helpers/board.ts'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

function card(
  board: ReturnType<typeof makeBoard>,
  status: string,
  opts: { skill?: string; note?: string; title?: string; position?: number } = {},
) {
  const created = seedCard(board.db, {
    phase: 'task',
    status: status as never,
    skill: opts.skill ?? 'dev',
    position: opts.position,
  })
  if (opts.note !== undefined || opts.title !== undefined) {
    board.db
      .prepare('update cards set note = ?, title = ? where id = ?')
      .run(opts.note ?? null, opts.title ?? created.title, created.id)
  }
  return created
}

test('renderBacklog: статусы, группы, отложенные и готовые', (t) => {
  const board = makeBoard()
  t.after(board.close)

  card(board, 'new', { title: 'Новый' })
  card(board, 'shaping', { skill: 'owner', title: 'Разбор' })
  card(board, 'approval', { title: 'Утверждение' })
  card(board, 'ready', { title: 'Готов' })
  card(board, 'in_progress', { title: 'В работе' })
  card(board, 'review', { title: 'Ревью' })
  card(board, 'blocked', { note: 'нужен ответ', title: 'Блок' })
  card(board, 'deferred', { note: 'позже', title: 'Отложено' })

  const done = card(board, 'done', { title: 'Готово' })
  board.db.prepare('update cards set done_at = ? where id = ?').run(new Date().toISOString(), done.id)

  const waiting = card(board, 'waiting', { title: 'Ждёт' })
  const dep = card(board, 'ready', { title: 'Зависимость' })
  addDep(board.db, waiting.id, dep.id, 'owner')

  const md = renderBacklog(board.db)

  assert.match(md, /## Задачи для владельца/)
  assert.match(md, /## Задачи для dev/)
  assert.match(md, /ждёт утверждения владельцем/)
  assert.match(md, /ждёт другие карточки/)
  assert.match(md, /\| Ждёт \|.*ждёт: /)
  assert.match(md, /в работе/)
  assert.match(md, /ждёт финального ревью/)
  assert.match(md, /заблокирована/)
  assert.match(md, /## Отложенные/)
  assert.match(md, /позже/)
  assert.match(md, /## Готово за последние 12 часов/)
  assert.match(md, /Готово/)
  assert.doesNotMatch(md, /отменена/)
})

test('бэклог показывает демона в ID', (t) => {
  const board = makeBoard()
  t.after(board.close)
  const card = seedCard(board.db, { phase: 'task', status: 'ready', position: 1 })
  board.db.prepare('update cards set demons = 2 where id = ?').run(card.id)

  const md = renderBacklog(board.db)
  const html = renderBacklogPage(buildBacklog(board.db))
  assert.match(md, new RegExp(`${card.id} 👿 2`))
  assert.match(html, new RegExp(`${card.id} 👿 2`))

  board.db.prepare('update cards set demons = 0 where id = ?').run(card.id)
  assert.doesNotMatch(renderBacklog(board.db), /👿/)
})

test('renderBacklog: причина отложенной приходит из defer --note', (t) => {
  const board = makeBoard()
  t.after(board.close)
  seedExecutor(board.db)
  const card = seedCard(board.db, { phase: 'task', status: 'ready', position: 1 })

  deferCard(board.db, {
    id: card.id,
    actor: 'developer',
    note: 'Ждём макет. Вторая фраза не в колонку.',
  })

  const row = buildBacklog(board.db).deferred.find((item) => item.id === card.id)!
  assert.equal(row.note, 'Ждём макет. Вторая фраза не в колонку.')
  assert.equal(row.reason, 'Ждём макет.')
})

test('renderBacklog: приёмка — в начале задач владельца, без отдельной секции', (t) => {
  const board = makeBoard()
  t.after(board.close)
  const acceptance = seedCard(board.db, {
    phase: 'task',
    status: 'acceptance',
    skill: 'dev',
    title: 'Ждёт приёмки',
  })
  card(board, 'ready', { skill: 'owner', title: 'Задача владельца' })

  const data = buildBacklog(board.db)
  const owner = data.skills.find((section) => section.skill === 'owner')
  assert.ok(owner)
  assert.equal(owner.rows[0].id, acceptance.id)
  assert.equal(owner.rows[0].status, 'требует приёмки владельцем')
  assert.equal(data.skills.some((section) => section.rows.some((row) => row.id === acceptance.id && section.skill !== 'owner')), false)

  const md = renderBacklog(board.db)
  assert.doesNotMatch(md, /## Ждут приёмки/)
  assert.match(md, /требует приёмки владельцем/)
})

test('renderBacklog: идеи — отдельная таблица в конце, не в отложенных', (t) => {
  const board = makeBoard()
  t.after(board.close)
  card(board, 'deferred', { note: 'обычная', title: 'Отложенная задача' })
  const idea = addIdea(board.db, { text: 'Идея на будущее', actor: 'owner' })
  const detailed = addIdea(board.db, {
    text: 'Короткий заголовок\nПодробный текст идеи для md.',
    title: 'Короткий заголовок',
    actor: 'owner',
  })

  const md = renderBacklog(board.db)
  assert.match(md, /## Идеи/)
  assert.match(md, new RegExp(`\\| ${idea.id} \\| Идея на будущее \\|`))
  assert.match(md, new RegExp(`\\| ${detailed.id} \\| Короткий заголовок Подробный текст идеи для md\\. \\|`))
  const beforeIdeas = md.split('## Идеи')[0]
  assert.doesNotMatch(beforeIdeas, /Идея на будущее/)
  assert.match(beforeIdeas, /Отложенная задача/)
})

test('writeBacklog: путь из настроек, файл создаётся', (t) => {
  const board = makeBoard()
  t.after(board.close)
  card(board, 'new', { title: 'Одна' })

  const settings = readSettings(board.root)
  const path = writeBacklog(board.db, board.root, settings)

  assert.equal(path, join(board.root, 'docs/board/BACKLOG.md'))
  assert.match(readFileSync(path, 'utf8'), /Одна/)
})

test('writeBacklogHtml: Inter.ttf копируется рядом с HTML', (t) => {
  const board = makeBoard()
  t.after(board.close)
  card(board, 'ready', { title: 'Со шрифтом' })

  const path = writeBacklogHtml(board.db, board.root, readSettings(board.root))
  assert.ok(existsSync(join(dirname(path), BACKLOG_FONT_NAME)))
  assert.match(readFileSync(path, 'utf8'), /url\("Inter\.ttf"\)/)
})

test('flushBacklog: флаг по ревизии, без изменений файлы не трогает', (t) => {
  const board = makeBoard()
  t.after(board.close)
  card(board, 'ready', { title: 'Первая' })

  const first = flushBacklog(board.db, board.root)
  assert.equal(first.path, join(board.root, 'docs/board/BACKLOG.md'))
  assert.ok(existsSync(backlogStatePath(board.root)))
  assert.match(readFileSync(first.path!, 'utf8'), /Первая/)

  const second = flushBacklog(board.db, board.root)
  assert.equal(second.path, null)

  card(board, 'ready', { title: 'Вторая' })
  const third = flushBacklog(board.db, board.root)
  assert.equal(third.path, join(board.root, 'docs/board/BACKLOG.md'))
  assert.match(readFileSync(third.path!, 'utf8'), /Вторая/)

  updateSettings(board.root, { backlog: { refreshSeconds: 10 } })
  const changed = flushBacklog(board.db, board.root)
  assert.ok(changed.path)
  const changedHtml = readFileSync(changed.path!.replace(/\.md$/, '.html'), 'utf8')
  assert.match(changedHtml, /Вторая/)
  assert.match(changedHtml, /авто 10 с/)

  updateSettings(board.root, { backlog: { auto: false } })
  assert.equal(flushBacklog(board.db, board.root).path, null)
})

test('бэклог: owner после --bottom идёт последним в секции', (t) => {  const board = makeBoard()
  t.after(board.close)

  const first = seedCard(board.db, {
    phase: 'task',
    status: 'ready',
    skill: 'owner',
    position: 1,
  })
  const second = seedCard(board.db, {
    phase: 'task',
    status: 'ready',
    skill: 'owner',
    position: 2,
  })
  seedCard(board.db, { phase: 'task', status: 'ready', skill: 'dev', position: 1 })

  moveCard(board.db, first.id, { bottom: true })

  const owner = buildBacklog(board.db).skills.find((section) => section.skill === 'owner')!
  assert.deepEqual(
    owner.rows.map((row) => row.id).slice(0, 2),
    [second.id, first.id],
  )
})

test('зависимая карточка идёт после блокирующей в секции', (t) => {
  const board = makeBoard()
  t.after(board.close)

  const dependent = seedCard(board.db, {
    phase: 'task',
    status: 'waiting',
    skill: 'dev',
    position: 1,
  })
  const blocker = seedCard(board.db, {
    phase: 'task',
    status: 'ready',
    skill: 'dev',
    position: 2,
  })
  addDep(board.db, dependent.id, blocker.id, 'owner')

  const dev = buildBacklog(board.db).skills.find((section) => section.skill === 'dev')!
  const ids = dev.rows.map((row) => row.id)
  assert.ok(ids.indexOf(blocker.id) < ids.indexOf(dependent.id))
})

test('зависимость в другой секции уводит карточку в конец своей', (t) => {
  const board = makeBoard()
  t.after(board.close)

  const dependent = seedCard(board.db, {
    phase: 'task',
    status: 'waiting',
    skill: 'dev',
    position: 1,
  })
  const other = seedCard(board.db, {
    phase: 'task',
    status: 'ready',
    skill: 'dev',
    position: 2,
  })
  const external = seedCard(board.db, {
    phase: 'task',
    status: 'ready',
    skill: 'marketing',
    position: 1,
  })
  addDep(board.db, dependent.id, external.id, 'owner')

  const dev = buildBacklog(board.db).skills.find((section) => section.skill === 'dev')!
  assert.deepEqual(dev.rows.map((row) => row.id), [other.id, dependent.id])
})
