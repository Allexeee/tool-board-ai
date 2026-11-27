import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { openDb } from '../../src/core/db.ts'
import { listEvents } from '../../src/core/events.ts'
import { updateSettings } from '../../src/core/settings.ts'

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
  const dir = mkdtempSync(join(tmpdir(), 'board-cli-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))

  const init = run(dir, ['init'])
  assert.equal(init.code, 0, init.err)
  return dir
}

function json(dir: string, args: string[]) {
  const result = run(dir, [...args, '--json'])
  assert.equal(result.code, 0, result.err)
  return JSON.parse(result.out)
}

test('профиль card:never: add и edit сами пишут waiver', (t) => {
  const dir = project(t)
  const quiet = {
    spec: 'self' as const,
    specWords: 0,
    card: 'never' as const,
    reopens: 1,
    run: 'none' as const,
    findings: 'critical' as const,
  }
  updateSettings(dir, { review: { profile: 'quiet', profiles: { quiet } } })

  const added = json(dir, ['card', 'add', '--group', 'UI', '--title', 'тихая', '--skill', 'dev'])
  assert.equal(added.reviewRequired, false)

  const db = openDb(join(dir, '.board', 'board.db'))
  try {
    const waived = listEvents(db, added.id as string).filter(
      (event) => event.type === 'card.review_waived',
    )
    assert.equal(waived.length, 1)
    assert.match(waived[0].note ?? '', /профиль quiet/)

    // edit --needs-merge под never тоже снимает ревью waiver'ом, а не молча.
    db.prepare('update cards set review_required = 1 where id = ?').run(added.id)
    db.prepare("delete from events where subject = ? and type = 'card.review_waived'").run(added.id)
  } finally {
    db.close()
  }

  const edited = json(dir, ['card', 'edit', added.id as string, '--needs-merge'])
  assert.equal(edited.reviewRequired, false)

  const after = openDb(join(dir, '.board', 'board.db'))
  try {
    const waived = listEvents(after, added.id as string).filter(
      (event) => event.type === 'card.review_waived',
    )
    assert.equal(waived.length, 1)
    assert.match(waived[0].note ?? '', /профиль quiet/)
  } finally {
    after.close()
  }
})

test('card add: --no-review требует owner и причину, пишет waiver', (t) => {
  const dir = project(t)

  const noReason = run(dir, ['card', 'add', '--group', 'UI', '--title', 'x', '--skill', 'dev', '--no-review', '--as', 'owner'])
  assert.equal(noReason.code, 3)

  const notOwner = run(dir, [
    'card', 'add', '--group', 'UI', '--title', 'x', '--skill', 'dev',
    '--no-review', '--reason', 'маленькая правка', '--as', 'developer',
  ])
  assert.equal(notOwner.code, 3)

  const card = json(dir, [
    'card', 'add', '--group', 'UI', '--title', 'x', '--skill', 'dev',
    '--no-review', '--reason', 'маленькая правка', '--as', 'owner',
  ])
  assert.equal(card.reviewRequired, false)

  const db = openDb(join(dir, '.board', 'board.db'))
  try {
    const waived = listEvents(db, card.id).filter((event) => event.type === 'card.review_waived')
    assert.equal(waived.length, 1)
    assert.match(waived[0].note ?? '', /маленькая правка/)
  } finally {
    db.close()
  }
})

test('профиль max: карточка без merge всё равно в ревью', (t) => {
  const dir = project(t)
  json(dir, ['setup', '--profile', 'max'])
  const card = json(dir, [
    'card', 'add', '--group', 'UI', '--title', 'x', '--skill', 'dev', '--no-needs-merge',
  ])
  assert.equal(card.reviewRequired, true)
})

test('card add заводит запрос и печатает его в json', (t) => {
  const dir = project(t)

  const card = json(dir, [
    'card', 'add',
    '--group', 'UI',
    '--title', 'Форма входа',
    '--skill', 'dev',
  ])

  assert.equal(card.id, 'UI-1')
  assert.equal(card.title, 'Форма входа')
  assert.equal(card.phase, 'request')
  assert.equal(card.status, 'new')
  assert.equal(card.skill, 'dev')
  assert.equal(card.needsMerge, true)
  assert.equal(card.reviewRequired, true)
})

test('card add принимает spec и повторяемый acceptance', (t) => {
  const dir = project(t)

  const card = json(dir, [
    'card', 'add',
    '--group', 'UI',
    '--title', 'Форма входа',
    '--skill', 'dev',
    '--spec', 'Что и зачем',
    '--acceptance', 'Первый критерий',
    '--acceptance', 'Второй критерий',
  ])

  assert.equal(card.body, 'Что и зачем')
  assert.equal(card.acceptance, 'Первый критерий\nВторой критерий')
  assert.equal(card.specRev, 1)
})

test('card add с навыком owner создаёт задачу в ready', (t) => {
  const dir = project(t)

  const card = json(dir, [
    'card', 'add',
    '--group', 'OPS',
    '--title', 'Создать VK группу',
    '--skill', 'owner',
  ])

  assert.equal(card.id, 'OPS-1')
  assert.equal(card.phase, 'task')
  assert.equal(card.status, 'ready')
  assert.equal(card.needsMerge, false)
  assert.equal(card.reviewRequired, false)
})

test('card add пишет --as в журнал, по умолчанию owner', (t) => {
  const dir = project(t)

  const byDeveloper = json(dir, [
    'card', 'add',
    '--group', 'UI',
    '--title', 'Форма входа',
    '--skill', 'dev',
    '--as', 'developer',
  ])
  const byOwner = json(dir, ['card', 'add', '--group', 'UI', '--title', 'Валидация', '--skill', 'dev'])

  const db = openDb(join(dir, '.board', 'board.db'))
  try {
    assert.equal(listEvents(db, byDeveloper.id)[0].actor, 'developer')
    assert.equal(listEvents(db, byOwner.id)[0].actor, 'owner')
  } finally {
    db.close()
  }
})

test('card add требует --title и --skill, без --group берёт CARD', (t) => {
  const dir = project(t)

  const noGroup = run(dir, ['card', 'add', '--title', 'x', '--skill', 'dev', '--json'])
  assert.equal(noGroup.code, 0)
  assert.equal(JSON.parse(noGroup.out).id, 'CARD-1')

  const noTitle = run(dir, ['card', 'add', '--group', 'CARD', '--skill', 'dev'])
  assert.equal(noTitle.code, 3)
  assert.match(noTitle.err, /--title/)

  const noSkill = run(dir, ['card', 'add', '--group', 'CARD', '--title', 'x'])
  assert.equal(noSkill.code, 3)
  assert.match(noSkill.err, /--skill/)
})

test('card show печатает id, статус, навык, оценки, scope и body', (t) => {
  const dir = project(t)

  json(dir, [
    'card', 'add',
    '--group', 'UI',
    '--title', 'Форма входа',
    '--skill', 'dev',
    '--body', 'Подробное описание задачи',
  ])
  json(dir, [
    'card', 'edit', 'UI-1',
    '--importance', '2',
    '--urgency', '3',
    '--scope', 'src/**',
  ])

  const shown = run(dir, ['card', 'show', 'UI-1'])
  assert.equal(shown.code, 0, shown.err)
  assert.match(shown.out, /UI-1/)
  assert.match(shown.out, /Форма входа/)
  assert.match(shown.out, /статус: new/)
  assert.match(shown.out, /фаза: request/)
  assert.match(shown.out, /навык: dev/)
  assert.match(shown.out, /важность: 2/)
  assert.match(shown.out, /срочность: 3/)
  assert.match(shown.out, /мерж: да/)
  assert.match(shown.out, /ревью: да/)
  assert.match(shown.out, /scope: src\/\*\*/)
  assert.match(shown.out, /Подробное описание задачи/)

  const missing = run(dir, ['card', 'show', 'UI-9'])
  assert.equal(missing.code, 3)
  assert.match(missing.err, /не найдена/)
})

test('card edit меняет поля и признак ревью', (t) => {
  const dir = project(t)
  json(dir, ['card', 'add', '--group', 'UI', '--title', 'Форма', '--skill', 'dev'])

  const edited = json(dir, [
    'card', 'edit', 'UI-1',
    '--title', 'Форма регистрации',
    '--body', 'Текст',
    '--importance', '2',
    '--urgency', '1',
    '--no-needs-merge',
    '--review',
    '--scope', 'src/**',
    '--scope', 'tests/**',
  ])

  assert.equal(edited.title, 'Форма регистрации')
  assert.equal(edited.body, 'Текст')
  assert.equal(edited.importance, 2)
  assert.equal(edited.urgency, 1)
  assert.equal(edited.needsMerge, false)
  assert.equal(edited.reviewRequired, true)
  assert.deepEqual(edited.scope, ['src/**', 'tests/**'])
})

test('card list фильтрует и печатает карточки', (t) => {
  const dir = project(t)
  json(dir, ['card', 'add', '--group', 'UI', '--title', 'Форма', '--skill', 'dev'])
  json(dir, ['card', 'add', '--group', 'UI', '--title', 'Валидация', '--skill', 'dev'])
  json(dir, ['card', 'add', '--group', 'OPS', '--title', 'Группа', '--skill', 'owner', '--new-group'])

  const requests = json(dir, ['card', 'list', '--status', 'new'])
  assert.deepEqual(
    requests.map((card: { id: string }) => card.id),
    ['UI-1', 'UI-2'],
  )

  const owned = json(dir, ['card', 'list', '--skill', 'owner'])
  assert.deepEqual(
    owned.map((card: { id: string }) => card.id),
    ['OPS-1'],
  )

  const all = json(dir, ['card', 'list'])
  assert.equal(all.length, 3)

  const human = run(dir, ['card', 'list'])
  assert.equal(human.code, 0, human.err)
  assert.match(human.out, /UI-2/)
  assert.match(human.out, /OPS-1/)
  assert.match(human.out, /new/)
})

test('card add и edit принимают теги из реестра', (t) => {
  const dir = project(t)
  assert.equal(run(dir, ['tag', 'add', 'backend']).code, 0)

  const unknown = run(dir, [
    'card', 'add', '--group', 'UI', '--title', 't', '--skill', 'dev', '--tag', 'nope',
  ])
  assert.equal(unknown.code, 3)
  assert.match(unknown.err, /не найден/)

  const added = json(dir, [
    'card', 'add', '--group', 'UI', '--title', 't', '--skill', 'dev',
    '--tag', 'New', '--tag', 'backend',
  ])
  assert.deepEqual(added.tags, ['new', 'backend'])

  const edited = json(dir, ['card', 'edit', 'UI-1', '--tag', 'review'])
  assert.deepEqual(edited.tags, ['review'])

  const cleared = json(dir, ['card', 'edit', 'UI-1', '--clear-tags'])
  assert.deepEqual(cleared.tags, [])
})

test('card add с невалидной оценкой не создаёт карточку', (t) => {
  const dir = project(t)

  const bad = run(dir, [
    'card', 'add', '--group', 'UI', '--title', 'Плохая', '--skill', 'dev', '--importance', '4',
  ])
  assert.equal(bad.code, 3)
  assert.match(bad.err, /0 до 3/)

  const negative = run(dir, [
    'card', 'add', '--group', 'UI', '--title', 'Плохая', '--skill', 'dev', '--urgency', '-1',
  ])
  assert.equal(negative.code, 3)

  const list = json(dir, ['card', 'list'])
  assert.equal(list.length, 0)
})

test('card scope add расширяет scope у карточки в работе через CLI', (t) => {
  const dir = project(t)
  const card = json(dir, [
    'card', 'add', '--group', 'UI', '--title', 'x', '--skill', 'dev',
  ]) as { id: string }

  const db = openDb(join(dir, '.board', 'board.db'))
  db.prepare("update cards set status = 'ready', holder = 'developer' where id = ?").run(card.id)
  db.close()

  const updated = json(dir, ['card', 'scope', 'add', card.id, 'src/a.ts', '--as', 'developer']) as {
    scope: string[]
  }
  assert.deepEqual(updated.scope, ['src/a.ts'])
})

test('card add сохраняет scope, review, note и needs_merge', (t) => {
  const dir = project(t)
  const added = run(dir, [
    'card', 'add', '--group', 'UI', '--title', 't', '--skill', 'dev', '--as', 'owner',
    '--scope', 'src/**', '--review', '--no-needs-merge', '--note', 'n', '--json',
  ])
  assert.equal(added.code, 0, added.err)
  const card = JSON.parse(added.out)
  assert.deepEqual(card.scope, ['src/**'])
  assert.equal(card.reviewRequired, true)
  assert.equal(card.needsMerge, false)
  assert.equal(card.note, 'n')
})
