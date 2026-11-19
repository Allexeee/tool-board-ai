import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  addOwnerCommand,
  addTerm,
  ensureTerminology,
  listOwnerCommands,
  listTerms,
  showTerm,
} from '../../src/core/terminology.ts'
import { makeBoard } from '../helpers/board.ts'

test('initProject создаёт terminology.md с двумя разделами', (t) => {
  const board = makeBoard()
  t.after(board.close)

  const path = join(board.root, 'docs', 'board', 'terminology.md')
  assert.ok(existsSync(path))
  const text = readFileSync(path, 'utf8')
  assert.match(text, /# Терминология/)
  assert.match(text, /## Термины/)
  assert.match(text, /## Команды владельца/)
})

test('ensureTerminology идемпотентна и не перезаписывает существующий файл', (t) => {
  const board = makeBoard()
  t.after(board.close)
  const path = join(board.root, 'docs', 'board', 'terminology.md')

  writeFileSync(path, '# Моя терминология\nсвои заметки\n')
  ensureTerminology(board.root)

  assert.equal(readFileSync(path, 'utf8'), '# Моя терминология\nсвои заметки\n')
})

test('addTerm добавляет строку, дубликат предупреждает, команды только owner', (t) => {
  const board = makeBoard()
  t.after(board.close)

  ensureTerminology(board.root)
  assert.equal(
    addTerm(board.root, { term: 'забег', definition: 'сессия 1–3 карточек', author: 'developer' })
      .added,
    true,
  )
  assert.equal(
    addTerm(board.root, { term: 'забег', definition: 'другое', author: 'marketer' }).duplicate,
    true,
  )
  assert.equal(listTerms(board.root).length, 2)

  assert.throws(
    () => addOwnerCommand(board.root, { command: 'RUN', action: 'запуск', author: 'developer' }),
    /owner/,
  )
  addOwnerCommand(board.root, { command: 'RUN', action: 'запуск забега', author: 'owner' })
  assert.equal(listOwnerCommands(board.root)[0].command, 'RUN')
})

test('addTerm сохраняет чужие строки файла', (t) => {
  const board = makeBoard()
  t.after(board.close)
  const path = join(board.root, 'docs', 'board', 'terminology.md')

  const withNote = readFileSync(path, 'utf8').replace(
    '# Терминология\n',
    '# Терминология\n\nмоя заметка\n',
  )
  writeFileSync(path, withNote)

  addTerm(board.root, { term: 'спринт', definition: 'неделя работы', author: 'owner' })

  const after = readFileSync(path, 'utf8')
  assert.match(after, /моя заметка/)
  assert.match(after, /спринт/)
  assert.equal(listTerms(board.root).length, 1)
})

test('showTerm ищет точное совпадение', (t) => {
  const board = makeBoard()
  t.after(board.close)

  addTerm(board.root, { term: 'забег', definition: 'сессия', author: 'owner' })

  assert.equal(showTerm(board.root, 'забег')?.definition, 'сессия')
  assert.equal(showTerm(board.root, 'заб'), null)
})

test('занятый lock приводит к таймауту', (t) => {
  const board = makeBoard()
  t.after(board.close)

  const lock = join(board.root, '.board', 'terminology.lock')
  writeFileSync(lock, '')

  assert.throws(
    () => addTerm(board.root, { term: 'забег', definition: 'сессия', author: 'developer' }),
    /таймаут|timeout|занят/,
  )
})
