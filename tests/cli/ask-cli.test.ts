import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const bin = resolve('bin/board.ts')

function run(dir: string, args: string[]) {
  const result = spawnSync(process.execPath, [bin, ...args], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, BOARD_ALLOW_GLOBAL: '1' },
    windowsHide: true,
  })
  return { code: result.status, out: result.stdout, err: result.stderr }
}

function project(t: { after: (fn: () => void) => void }): string {
  const dir = mkdtempSync(join(tmpdir(), 'board-ask-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))

  const init = run(dir, ['init'])
  assert.equal(init.code, 0, init.err)
  const card = run(dir, ['card', 'add', '--group', 'UI', '--title', 'Форма', '--skill', 'dev'])
  assert.equal(card.code, 0, card.err)
  return dir
}

function json(dir: string, args: string[]) {
  const result = run(dir, [...args, '--json'])
  assert.equal(result.code, 0, result.err)
  return JSON.parse(result.out)
}

test('ask задаёт вопрос от имени исполнителя', (t) => {
  const dir = project(t)

  const question = json(dir, ['ask', 'UI-1', 'Нужен ли SSO?', '--as', 'developer'])

  assert.equal(question.cardId, 'UI-1')
  assert.equal(question.kind, 'question')
  assert.equal(question.status, 'open')
  assert.equal(question.author, 'developer')
  assert.equal(question.text, 'Нужен ли SSO?')
})

test('ask по умолчанию действует от owner', (t) => {
  const dir = project(t)

  const question = json(dir, ['ask', 'UI-1', 'Нужен ли SSO?'])

  assert.equal(question.author, 'owner')
})

test('answer закрывает вопрос владельца и виден в card show', (t) => {
  const dir = project(t)
  const question = json(dir, ['ask', 'UI-1', 'Нужен ли SSO?', '--as', 'developer'])

  const reply = json(dir, ['answer', 'UI-1', 'Нет', '--as', 'owner'])

  assert.equal(reply.kind, 'answer')
  assert.equal(reply.answerTo, question.id)
  assert.equal(reply.author, 'owner')

  const shown = run(dir, ['card', 'show', 'UI-1'])
  assert.equal(shown.code, 0, shown.err)
  assert.match(shown.out, /ОБСУЖДЕНИЕ/)
  assert.match(shown.out, /Нужен ли SSO\?/)
  assert.match(shown.out, /Нет/)
  assert.match(shown.out, /вопрос #\d+/)
  assert.match(shown.out, /ответ #\d+ → вопрос #\d+/)
})

test('answer без открытых вопросов отказывает', (t) => {
  const dir = project(t)

  const result = run(dir, ['answer', 'UI-1', 'Нет', '--as', 'owner'])

  assert.equal(result.code, 3)
  assert.match(result.err, /открытых вопросов нет/)
})

test('answer при нескольких вопросах требует --question', (t) => {
  const dir = project(t)
  const first = json(dir, ['ask', 'UI-1', 'Первый?', '--as', 'developer'])
  json(dir, ['ask', 'UI-1', 'Второй?', '--as', 'developer'])

  const ambiguous = run(dir, ['answer', 'UI-1', 'Да', '--as', 'owner'])
  assert.equal(ambiguous.code, 3)
  assert.match(ambiguous.err, /--question/)

  const reply = json(dir, [
    'answer', 'UI-1', 'Да', '--question', String(first.id), '--as', 'owner',
  ])
  assert.equal(reply.answerTo, first.id)
})

test('ask и answer объясняют использование без аргументов', (t) => {
  const dir = project(t)

  const noText = run(dir, ['ask', 'UI-1'])
  assert.equal(noText.code, 3)
  assert.match(noText.err, /использование: board ask/)

  const noCard = run(dir, ['ask'])
  assert.equal(noCard.code, 3)
  assert.match(noCard.err, /использование: board ask/)

  const answerNoText = run(dir, ['answer', 'UI-1'])
  assert.equal(answerNoText.code, 3)
  assert.match(answerNoText.err, /использование: board answer/)
})

test('ask по несуществующей карточке отказывает', (t) => {
  const dir = project(t)

  const result = run(dir, ['ask', 'UI-9', 'Вопрос?', '--as', 'developer'])

  assert.equal(result.code, 3)
  assert.match(result.err, /не найдена/)
})
