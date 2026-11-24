import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { getCard } from '../../src/core/cards.ts'
import { openDb } from '../../src/core/db.ts'

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
  const dir = mkdtempSync(join(tmpdir(), 'board-shape-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))

  const init = run(dir, ['init'])
  assert.equal(init.code, 0, init.err)
  return dir
}

/** Карточка после неудачного shape --from должна остаться запросом new. */
function assertUntouched(dir: string, id: string): void {
  const db = openDb(join(dir, '.board', 'board.db'))
  try {
    const card = getCard(db, id)!
    assert.equal(card.status, 'new', 'статус должен остаться new')
    assert.equal(card.holder, null, 'держатель должен быть пуст')
    assert.equal(card.leaseUntil, null, 'аренда разбора не должна появиться')
  } finally {
    db.close()
  }
}

test('shape --from с невалидным JSON оставляет карточку нетронутой', (t) => {
  const dir = project(t)
  const add = run(dir, ['card', 'add', '--group', 'UI', '--title', 'x', '--skill', 'dev'])
  assert.equal(add.code, 0, add.err)

  writeFileSync(join(dir, 'bad.json'), '{ невалидный json')

  const result = run(dir, ['card', 'shape', 'UI-1', '--as', 'developer', '--from', 'bad.json'])
  assert.equal(result.code, 3)
  assert.match(result.err, /JSON/)

  assertUntouched(dir, 'UI-1')
})

test('shape --from с новой карточкой без группы оставляет карточку нетронутой', (t) => {
  const dir = project(t)
  const add = run(dir, ['card', 'add', '--group', 'UI', '--title', 'x', '--skill', 'dev'])
  assert.equal(add.code, 0, add.err)

  writeFileSync(
    join(dir, 'plan.json'),
    JSON.stringify({
      body: 'x',
      skill: 'dev',
      importance: 3,
      urgency: 2,
      new_cards: [{ key: 'gen', title: 'без группы', skill: 'dev' }],
    }),
  )

  const result = run(dir, ['card', 'shape', 'UI-1', '--as', 'developer', '--from', 'plan.json'])
  assert.equal(result.code, 3)
  assert.match(result.err, /групп/)

  assertUntouched(dir, 'UI-1')
})

test('shape --from с ошибкой внутри разбора откатывает переход в shaping', (t) => {
  const dir = project(t)
  const add = run(dir, ['card', 'add', '--group', 'UI', '--title', 'x', '--skill', 'dev'])
  assert.equal(add.code, 0, add.err)

  // Зависимость на несуществующую карточку падает уже внутри applyShapeFile,
  // после shapeCard: транзакция должна откатить и переход в shaping.
  writeFileSync(
    join(dir, 'plan.json'),
    JSON.stringify({ body: 'x', skill: 'dev', importance: 3, urgency: 2, deps: ['UI-999'] }),
  )

  const result = run(dir, ['card', 'shape', 'UI-1', '--as', 'developer', '--from', 'plan.json'])
  assert.equal(result.code, 3)
  assert.match(result.err, /не найдена/)

  assertUntouched(dir, 'UI-1')
})

test('submit --no-decisions ставит карточку в очередь без approve', (t) => {
  const dir = project(t)
  assert.equal(run(dir, ['executor', 'add', 'developer', '--kind', 'agent', '--skills', 'dev']).code, 0)
  const add = run(dir, [
    'card', 'add', '--group', 'UI', '--title', 'x', '--skill', 'dev',
    '--spec', 'spec', '--acceptance', 'готово', '--importance', '2', '--urgency', '2',
    '--scope', 'src/**',
  ])
  assert.equal(add.code, 0, add.err)
  assert.equal(run(dir, ['card', 'shape', 'UI-1', '--as', 'developer']).code, 0)
  assert.equal(
    run(dir, [
      'card', 'spec-review', 'UI-1', '--as', 'developer',
      '--mode', 'self', '--verdict', 'done', '--note', 'ok',
    ]).code,
    0,
  )

  const submitted = run(dir, ['card', 'submit', 'UI-1', '--as', 'developer', '--no-decisions'])
  assert.equal(submitted.code, 0, submitted.err)
  assert.match(submitted.out, /без утверждения/)

  const db = openDb(join(dir, '.board', 'board.db'))
  try {
    const card = getCard(db, 'UI-1')!
    assert.equal(card.status, 'ready')
    assert.ok(card.approvedAt !== null)
  } finally {
    db.close()
  }
})
