import test from 'node:test'
import assert from 'node:assert/strict'
import { addDep } from '../../src/core/deps.ts'
import { addIdea } from '../../src/core/cards.ts'
import {
  backlogStatePath,
  flushBacklog,
  renderBacklog,
  writeBacklog,
} from '../../src/core/backlog.ts'
import { readSettings, updateSettings } from '../../src/core/settings.ts'
import { makeBoard, seedCard } from '../helpers/board.ts'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

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
  assert.match(md, /ждет финального ревью/)
  assert.match(md, /заблокирована/)
  assert.match(md, /## Отложенные/)
  assert.match(md, /позже/)
  assert.match(md, /## Готово за последние 12 часов/)
  assert.match(md, /Готово/)
  assert.doesNotMatch(md, /отменена/)
})

test('renderBacklog: идеи — отдельная таблица в конце, не в отложенных', (t) => {
  const board = makeBoard()
  t.after(board.close)
  card(board, 'deferred', { note: 'обычная', title: 'Отложенная задача' })
  const idea = addIdea(board.db, { text: 'Идея на будущее', actor: 'owner' })

  const md = renderBacklog(board.db)
  assert.match(md, /## Идеи/)
  assert.match(md, new RegExp(`\\| ${idea.id} \\| Идея на будущее \\|`))
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
