import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { getCard, listCards } from '../../src/core/cards.ts'
import { getRun, listRunCards, listRuns } from '../../src/core/runs.ts'
import { makeBoard, seedCard, seedExecutor } from '../helpers/board.ts'

const bin = resolve('bin/board.ts')

interface Result {
  code: number | null
  out: string
  err: string
}

function run(dir: string, args: string[]): Result {
  const result = spawnSync(process.execPath, [bin, ...args], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, BOARD_ALLOW_GLOBAL: '1' },
    windowsHide: true,
  })
  return { code: result.status, out: result.stdout ?? '', err: result.stderr ?? '' }
}

function spawnBoard(dir: string, args: string[]): Promise<Result> {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [bin, ...args], {
      cwd: dir,
      env: { ...process.env, BOARD_ALLOW_GLOBAL: '1' },
    windowsHide: true,
    })
    let out = ''
    let err = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => (out += chunk))
    child.stderr.on('data', (chunk: string) => (err += chunk))
    child.on('close', (code) => resolvePromise({ code, out, err }))
  })
}

function json(dir: string, args: string[]): unknown {
  const result = run(dir, [...args, '--json'])
  assert.equal(result.code, 0, result.err)
  return JSON.parse(result.out)
}

/** Проект с исполнителем developer и четырьмя задачами UI-1..UI-4. */
function project(t: { after: (fn: () => void) => void }) {
  const fixture = makeBoard()
  t.after(fixture.close)
  seedExecutor(fixture.db, { id: 'developer', skills: ['dev'], runSize: 3 })
  const cards = [1, 2, 3, 4].map((position) =>
    seedCard(fixture.db, {
      phase: 'task',
      status: 'ready',
      position,
      title: `Задача ${position}`,
      tags: ['new'],
    }),
  )
  return { ...fixture, cards }
}

test('run start --suggest берёт предложенный забег и блокирует второй', (t) => {
  const { root, db } = project(t)

  const started = json(root, ['run', 'start', '--as', 'developer', '--suggest', '1']) as {
    id: string
    status: string
    executorId: string
  }
  assert.equal(started.id, 'RUN-1')
  assert.equal(started.status, 'active')
  assert.equal(started.executorId, 'developer')

  const held = listCards(db, { holder: 'developer' })
  assert.equal(held.length, 3)
  assert.ok(held.every((card) => card.status === 'booked' && card.runId === 'RUN-1'))

  const second = run(root, ['run', 'start', '--as', 'developer', '--cards', 'UI-4'])
  assert.equal(second.code, 3)
  assert.match(second.err, /активный забег/)
})

test('run start --cards, add, drop, next и end --review', (t) => {
  const { root, db, cards } = project(t)

  const started = run(root, ['run', 'start', '--as', 'developer', '--cards', cards[0].id])
  assert.equal(started.code, 0, started.err)
  assert.match(started.out, /RUN-1 · developer · UI-1/)

  const added = json(root, ['run', 'add', cards[1].id, '--as', 'developer']) as {
    run: { id: string }
    card: { id: string; status: string }
  }
  assert.equal(added.run.id, 'RUN-1')
  assert.equal(added.card.status, 'booked')

  const next = json(root, ['run', 'next', '--as', 'developer']) as { id: string }
  assert.equal(next.id, cards[0].id)

  const dropped = json(root, ['run', 'drop', cards[1].id, '--as', 'developer']) as {
    card: { id: string; status: string; runId: string | null }
  }
  assert.equal(dropped.card.status, 'ready')
  assert.equal(dropped.card.runId, null)

  const ended = run(root, ['run', 'end', '--as', 'developer', '--review'])
  assert.equal(ended.code, 0, ended.err)
  assert.match(ended.out, /RUN-1 закрыт/)
  assert.match(ended.out, /ревью: self/)

  const runRecord = getRun(db, 'RUN-1')!
  assert.equal(runRecord.status, 'ended')
  assert.equal(runRecord.review, true)
  assert.equal(getCard(db, cards[0].id)!.status, 'ready')

  const listed = json(root, ['run', 'list']) as Array<{ id: string; status: string }>
  assert.equal(listed.length, 1)
  assert.equal(listed[0].id, 'RUN-1')
  assert.equal(listed[0].status, 'ended')
})

test('run end: ревью после забега берётся из настройки, флаги перекрывают', (t) => {
  const { root, db, cards } = project(t)

  json(root, ['run', 'start', '--as', 'developer', '--cards', cards[0].id])
  const plain = run(root, ['run', 'end', '--as', 'developer'])
  assert.equal(plain.code, 0, plain.err)
  assert.match(plain.out, /ревью после забега выключено/)
  assert.equal(getRun(db, 'RUN-1')!.review, false)

  json(root, ['setup', '--review-after-run', '--reviewer-model', 'acme/model'])
  json(root, ['run', 'start', '--as', 'developer', '--cards', cards[1].id])
  const enabled = run(root, ['run', 'end', '--as', 'developer'])
  assert.equal(enabled.code, 0, enabled.err)
  assert.match(enabled.out, /ревью: subagent/)
  assert.equal(getRun(db, 'RUN-2')!.review, true)

  json(root, ['run', 'start', '--as', 'developer', '--cards', cards[2].id])
  const disabled = run(root, ['run', 'end', '--as', 'developer', '--no-review'])
  assert.equal(disabled.code, 0, disabled.err)
  assert.match(disabled.out, /ревью после забега выключено/)
  assert.equal(getRun(db, 'RUN-3')!.review, false)
})

test('run end: --review и --no-review вместе — код 3', (t) => {
  const { root, db, cards } = project(t)
  json(root, ['run', 'start', '--as', 'developer', '--cards', cards[0].id])

  const both = run(root, ['run', 'end', '--as', 'developer', '--review', '--no-review'])
  assert.equal(both.code, 3)
  assert.match(both.err, /только один флаг/)
  assert.equal(getRun(db, 'RUN-1')!.status, 'active')
})

test('run start снимает reviewMode, finish покрывает все карточки', (t) => {
  const fixture = makeBoard()
  t.after(fixture.close)
  seedExecutor(fixture.db, { id: 'developer', skills: ['dev'] })
  const card = seedCard(fixture.db, {
    phase: 'task',
    status: 'ready',
    position: 1,
    needsMerge: false,
    body: 'spec',
    acceptance: ['готово'],
  })

  json(fixture.root, ['setup', '--run-review', 'subagent', '--reviewer-model', 'acme/model'])
  const run = json(fixture.root, ['run', 'start', '--as', 'developer', '--cards', card.id]) as {
    reviewMode: string
  }
  assert.equal(run.reviewMode, 'subagent')

  json(fixture.root, ['take', card.id, '--as', 'developer'])
  const finished = json(fixture.root, ['finish', card.id, '--as', 'developer', '--summary', 'ok']) as {
    status: string
  }
  assert.equal(finished.status, 'review')

  const ended = json(fixture.root, ['run', 'end', '--as', 'developer']) as {
    review: boolean
    reviewMode: string
    reviewCards: number
  }
  assert.equal(ended.review, true)
  assert.equal(ended.reviewMode, 'subagent')
  assert.equal(ended.reviewCards, 1)
})

test('run end --review переносит done-карточку в post-hoc review', (t) => {
  const fixture = makeBoard()
  t.after(fixture.close)
  seedExecutor(fixture.db, { id: 'developer', skills: ['dev'] })
  const card = seedCard(fixture.db, {
    phase: 'task',
    status: 'ready',
    position: 1,
    needsMerge: false,
    body: 'spec',
    acceptance: ['готово'],
  })

  json(fixture.root, ['setup', '--run-review', 'none'])
  json(fixture.root, ['run', 'start', '--as', 'developer', '--cards', card.id])
  json(fixture.root, ['take', card.id, '--as', 'developer'])
  assert.equal(
    (json(fixture.root, ['finish', card.id, '--as', 'developer', '--summary', 'ok']) as { status: string }).status,
    'done',
  )

  const ended = json(fixture.root, ['run', 'end', '--as', 'developer', '--review']) as {
    review: boolean
    reviewMode: string
    reviewCards: number
  }
  assert.equal(ended.review, true)
  assert.equal(ended.reviewMode, 'self')
  assert.equal(ended.reviewCards, 1)
  assert.equal((json(fixture.root, ['card', 'show', card.id]) as { status: string }).status, 'review')
})

test('run end --no-review не трогает done-карточки', (t) => {
  const fixture = makeBoard()
  t.after(fixture.close)
  seedExecutor(fixture.db, { id: 'developer', skills: ['dev'] })
  const card = seedCard(fixture.db, {
    phase: 'task',
    status: 'ready',
    position: 1,
    needsMerge: false,
    body: 'spec',
    acceptance: ['готово'],
  })

  json(fixture.root, ['setup', '--run-review', 'none'])
  json(fixture.root, ['run', 'start', '--as', 'developer', '--cards', card.id])
  json(fixture.root, ['take', card.id, '--as', 'developer'])
  json(fixture.root, ['finish', card.id, '--as', 'developer', '--summary', 'ok'])

  const ended = json(fixture.root, ['run', 'end', '--as', 'developer', '--no-review']) as {
    review: boolean
    reviewMode: string
    reviewCards: number
  }
  assert.equal(ended.review, false)
  assert.equal(ended.reviewMode, 'none')
  assert.equal(ended.reviewCards, 0)
  assert.equal((json(fixture.root, ['card', 'show', card.id]) as { status: string }).status, 'done')
})

test('run end с subagent без reviewer.model — код 2', (t) => {
  const fixture = makeBoard()
  t.after(fixture.close)
  seedExecutor(fixture.db, { id: 'developer', skills: ['dev'] })
  const card = seedCard(fixture.db, { phase: 'task', status: 'ready', position: 1 })

  json(fixture.root, ['setup', '--run-review', 'subagent'])
  json(fixture.root, ['run', 'start', '--as', 'developer', '--cards', card.id])
  const ended = run(fixture.root, ['run', 'end', '--as', 'developer'])
  assert.equal(ended.code, 2)
  assert.match(ended.err, /reviewer\.model|--reviewer-model/)
})

test('run list снимает просроченный lease', (t) => {
  const { root, db, cards } = project(t)
  json(root, ['run', 'start', '--as', 'developer', '--cards', cards[0].id])
  db.prepare("update runs set lease_until = '2000-01-01T00:00:00.000Z' where id = 'RUN-1'").run()

  const listed = json(root, ['run', 'list']) as Array<{ id: string; status: string }>
  assert.equal(listed[0].status, 'lease_expired')
  assert.equal(getCard(db, cards[0].id)!.status, 'ready')
  assert.equal(getCard(db, cards[0].id)!.holder, null)
})

test('run next без доступных карточек завершается кодом 1', (t) => {
  const { root, db, cards } = project(t)
  json(root, ['run', 'start', '--as', 'developer', '--cards', cards[0].id])
  db.prepare("update cards set status = 'blocked', holder = null where id = ?").run(cards[0].id)
  db.prepare("update run_cards set status = 'blocked' where card_id = ?").run(cards[0].id)

  const next = run(root, ['run', 'next', '--as', 'developer'])
  assert.equal(next.code, 1)
  assert.match(next.err, /нет доступных карточек/)
})

test('run release снимает забег и требует причину', (t) => {
  const { root, db, cards } = project(t)
  json(root, ['run', 'start', '--as', 'developer', '--cards', cards[0].id])

  const noReason = run(root, ['run', 'release', 'RUN-1'])
  assert.equal(noReason.code, 3)
  assert.match(noReason.err, /причина/)

  const released = json(root, ['run', 'release', 'RUN-1', '--reason', 'агент умер']) as {
    status: string
    note: string
  }
  assert.equal(released.status, 'cancelled')
  assert.equal(released.note, 'агент умер')
  assert.equal(getCard(db, cards[0].id)!.status, 'ready')

  const again = run(root, ['run', 'release', 'RUN-1', '--reason', 'ещё раз'])
  assert.equal(again.code, 3)
  assert.match(again.err, /не активен/)
})

test('run start проверяет --as, источник карточек и подкоманду', (t) => {
  const { root } = project(t)

  const noActor = run(root, ['run', 'start', '--cards', 'UI-1'])
  assert.equal(noActor.code, 3)
  assert.match(noActor.err, /--as/)

  const noSource = run(root, ['run', 'start', '--as', 'developer'])
  assert.equal(noSource.code, 3)
  assert.match(noSource.err, /--cards|--suggest/)

  const both = run(root, [
    'run', 'start', '--as', 'developer', '--cards', 'UI-1', '--suggest', '1',
  ])
  assert.equal(both.code, 3)
  assert.match(both.err, /одно/)

  const usage = run(root, ['run', 'wat'])
  assert.equal(usage.code, 3)
  assert.match(usage.err, /использование/)
})

test('два процесса не бронируют одну карточку дважды', async (t) => {
  const fixture = makeBoard()
  t.after(fixture.close)
  seedExecutor(fixture.db, { id: 'developer-1', skills: ['dev'] })
  seedExecutor(fixture.db, { id: 'developer-2', skills: ['dev'] })
  const card = seedCard(fixture.db, { phase: 'task', status: 'ready', position: 1 })

  const [first, second] = await Promise.all([
    spawnBoard(fixture.root, ['run', 'start', '--as', 'developer-1', '--cards', card.id, '--json']),
    spawnBoard(fixture.root, ['run', 'start', '--as', 'developer-2', '--cards', card.id, '--json']),
  ])

  const results = [first, second]
  assert.equal(results.filter((result) => result.code === 0).length, 1)
  assert.equal(results.filter((result) => result.code !== 0).length, 1)

  const booked = getCard(fixture.db, card.id)!
  assert.equal(booked.status, 'booked')
  assert.ok(['developer-1', 'developer-2'].includes(booked.holder!))
  assert.ok(booked.runId !== null)
  assert.equal(listRuns(fixture.db).length, 1)
  assert.equal(listRunCards(fixture.db, booked.runId!).length, 1)
  assert.equal(
    listCards(fixture.db, { status: 'booked' }).filter((item) => item.id === card.id).length,
    1,
  )
})
