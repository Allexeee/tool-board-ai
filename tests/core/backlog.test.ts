import test from 'node:test'
import assert from 'node:assert/strict'
import { addDep } from '../../src/core/deps.ts'
import { renderBacklog, writeBacklog } from '../../src/core/backlog.ts'
import { readSettings } from '../../src/core/settings.ts'
import { makeBoard, seedCard } from '../helpers/board.ts'
import { readFileSync } from 'node:fs'
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
  assert.match(md, /на ревью у агента/)
  assert.match(md, /заблокирована/)
  assert.match(md, /## Отложенные/)
  assert.match(md, /позже/)
  assert.match(md, /## Готово за последние 12 часов/)
  assert.match(md, /Готово/)
  assert.doesNotMatch(md, /отменена/)
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
