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
    windowsHide: true,
  })
  return { code: result.status, out: result.stdout, err: result.stderr }
}

function project(t: { after: (fn: () => void) => void }): string {
  const dir = mkdtempSync(join(tmpdir(), 'board-detail-'))
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

test('card step add/done/list/remove работает через CLI', (t) => {
  const dir = project(t)

  const first = json(dir, ['card', 'step', 'add', 'UI-1', 'Написать форму'])
  json(dir, ['card', 'step', 'add', 'UI-1', 'Добавить тест'])
  assert.equal(first.seq, 1)
  assert.equal(first.done, false)

  const marked = json(dir, ['card', 'step', 'done', 'UI-1', '1'])
  assert.equal(marked.done, true)
  assert.match(marked.doneAt, /^\d{4}-\d{2}-\d{2}T/)

  const steps = json(dir, ['card', 'step', 'list', 'UI-1'])
  assert.deepEqual(
    steps.map((step: { seq: number; done: boolean }) => [step.seq, step.done]),
    [
      [1, true],
      [2, false],
    ],
  )

  const human = run(dir, ['card', 'step', 'list', 'UI-1'])
  assert.match(human.out, /\[x\] 1\. Написать форму/)
  assert.match(human.out, /\[ \] 2\. Добавить тест/)
  assert.match(human.out, /1\/2/)

  const removed = json(dir, ['card', 'step', 'remove', 'UI-1', '2'])
  assert.equal(removed.seq, 2)
  assert.equal(json(dir, ['card', 'step', 'list', 'UI-1']).length, 1)
})

test('card ref add/list/remove работает через CLI', (t) => {
  const dir = project(t)

  const ref = json(dir, [
    'card', 'ref', 'add', 'UI-1',
    '--kind', 'spec',
    '--value', 'docs/specs/login.md',
    '--title', 'Спека логина',
  ])
  assert.equal(ref.kind, 'spec')
  assert.equal(ref.value, 'docs/specs/login.md')
  assert.equal(ref.title, 'Спека логина')

  const refs = json(dir, ['card', 'ref', 'list', 'UI-1'])
  assert.equal(refs.length, 1)

  const removed = json(dir, ['card', 'ref', 'remove', 'UI-1', String(ref.id)])
  assert.equal(removed.id, ref.id)
  assert.deepEqual(json(dir, ['card', 'ref', 'list', 'UI-1']), [])
})

test('card ref add проверяет --kind и --value', (t) => {
  const dir = project(t)

  const noKind = run(dir, ['card', 'ref', 'add', 'UI-1', '--value', 'x'])
  assert.equal(noKind.code, 3)
  assert.match(noKind.err, /--kind/)

  const badKind = run(dir, ['card', 'ref', 'add', 'UI-1', '--kind', 'video', '--value', 'x'])
  assert.equal(badKind.code, 3)
  assert.match(badKind.err, /kind/)

  const noValue = run(dir, ['card', 'ref', 'add', 'UI-1', '--kind', 'link'])
  assert.equal(noValue.code, 3)
  assert.match(noValue.err, /--value/)
})

test('card dep add/list/remove работает через CLI и виден в card show', (t) => {
  const dir = project(t)
  json(dir, ['card', 'add', '--group', 'UI', '--title', 'Основа', '--skill', 'dev'])

  const added = json(dir, ['card', 'dep', 'add', 'UI-1', 'UI-2'])
  assert.equal(added.from, 'UI-1')
  assert.equal(added.to, 'UI-2')
  assert.deepEqual(json(dir, ['card', 'dep', 'list', 'UI-1']), ['UI-2'])

  const shown = run(dir, ['card', 'show', 'UI-1'])
  assert.equal(shown.code, 0, shown.err)
  assert.match(shown.out, /ЗАВИСИМОСТИ/)
  assert.match(shown.out, /UI-2/)

  const cycle = run(dir, ['card', 'dep', 'add', 'UI-2', 'UI-1'])
  assert.equal(cycle.code, 3)
  assert.match(cycle.err, /цикл/)

  const removed = json(dir, ['card', 'dep', 'remove', 'UI-1', 'UI-2'])
  assert.equal(removed.to, 'UI-2')
  assert.deepEqual(json(dir, ['card', 'dep', 'list', 'UI-1']), [])
})

test('card dep отказывает без карточки', (t) => {
  const dir = project(t)

  const add = run(dir, ['card', 'dep', 'add', 'UI-1', 'UI-9'])
  assert.equal(add.code, 3)
  assert.match(add.err, /не найдена/)

  const list = run(dir, ['card', 'dep', 'list', 'UI-9'])
  assert.equal(list.code, 3)
  assert.match(list.err, /не найдена/)
})

test('card show печатает шаги, ссылки и журнал', (t) => {
  const dir = project(t)
  json(dir, ['card', 'step', 'add', 'UI-1', 'Написать форму'])
  json(dir, ['card', 'step', 'add', 'UI-1', 'Добавить тест'])
  json(dir, ['card', 'step', 'done', 'UI-1', '1'])
  json(dir, ['card', 'ref', 'add', 'UI-1', '--kind', 'spec', '--value', 'docs/specs/login.md'])

  const shown = run(dir, ['card', 'show', 'UI-1'])

  assert.equal(shown.code, 0, shown.err)
  assert.match(shown.out, /ШАГИ \(1\/2\)/)
  assert.match(shown.out, /\[x\] 1\. Написать форму/)
  assert.match(shown.out, /\[ \] 2\. Добавить тест/)
  assert.match(shown.out, /ССЫЛКИ/)
  assert.match(shown.out, /spec docs\/specs\/login\.md/)
  assert.match(shown.out, /ОБСУЖДЕНИЕ/)
  assert.match(shown.out, /обсуждения нет/)
  assert.match(shown.out, /ЖУРНАЛ/)
  assert.match(shown.out, /card\.created/)
  assert.match(shown.out, /step\.added/)
  assert.match(shown.out, /step\.updated/)
  assert.match(shown.out, /ref\.added/)
})

test('card show --json отдаёт карточку с шагами, ссылками, обсуждением и журналом', (t) => {
  const dir = project(t)
  json(dir, ['card', 'step', 'add', 'UI-1', 'Написать форму'])
  json(dir, ['card', 'ref', 'add', 'UI-1', '--kind', 'link', '--value', 'https://example.com'])
  json(dir, ['ask', 'UI-1', 'Нужен ли SSO?', '--as', 'developer'])
  json(dir, ['answer', 'UI-1', 'Нет', '--as', 'owner'])

  const detail = json(dir, ['card', 'show', 'UI-1'])

  assert.equal(detail.id, 'UI-1')
  assert.equal(detail.title, 'Форма')
  assert.equal(detail.steps.length, 1)
  assert.equal(detail.refs.length, 1)
  assert.equal(detail.discussion.length, 2)
  assert.equal(detail.events[0].type, 'card.created')
})

test('card step и card ref отказывают без карточки', (t) => {
  const dir = project(t)

  const step = run(dir, ['card', 'step', 'list', 'UI-9'])
  assert.equal(step.code, 3)
  assert.match(step.err, /не найдена/)

  const ref = run(dir, ['card', 'ref', 'list', 'UI-9'])
  assert.equal(ref.code, 3)
  assert.match(ref.err, /не найдена/)
})
