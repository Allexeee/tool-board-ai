import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { openDb } from '../../src/core/db.ts'
import { insertIntoQueue, listQueue } from '../../src/core/queue.ts'
import { seedCard } from '../helpers/board.ts'

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
  const dir = mkdtempSync(join(tmpdir(), 'board-queue-'))
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

function open(dir: string) {
  return openDb(join(dir, '.board', 'board.db'))
}

function queueIds(dir: string): string[] {
  const db = open(dir)
  try {
    return listQueue(db).map((card) => card.id)
  } finally {
    db.close()
  }
}

/** Три задачи с оценками 9, 4, 1; в очереди они стоят UI-1, UI-2, UI-3. */
function seedQueue(dir: string): { high: string; mid: string; low: string } {
  const db = open(dir)
  try {
    const high = seedCard(db, { phase: 'task', status: 'ready', importance: 3, urgency: 3 })
    const mid = seedCard(db, { phase: 'task', status: 'ready', importance: 2, urgency: 2 })
    const low = seedCard(db, { phase: 'task', status: 'ready', importance: 1, urgency: 1 })

    insertIntoQueue(db, low.id)
    insertIntoQueue(db, high.id)
    insertIntoQueue(db, mid.id)

    return { high: high.id, mid: mid.id, low: low.id }
  } finally {
    db.close()
  }
}

test('queue move переставляет наверх, вниз и перед карточкой', (t) => {
  const dir = project(t)
  const { high, mid, low } = seedQueue(dir)
  assert.deepEqual(queueIds(dir), [high, mid, low])

  const top = json(dir, ['queue', 'move', low, '--top'])
  assert.equal(top.id, low)
  assert.equal(top.position, 1)
  assert.deepEqual(queueIds(dir), [low, high, mid])

  const bottom = json(dir, ['queue', 'move', low, '--bottom'])
  assert.equal(bottom.position, 3)
  assert.deepEqual(queueIds(dir), [high, mid, low])

  const before = json(dir, ['queue', 'move', low, '--before', high])
  assert.equal(before.position, 1)
  assert.deepEqual(queueIds(dir), [low, high, mid])

  const human = run(dir, ['queue', 'move', mid, '--top'])
  assert.equal(human.code, 0, human.err)
  assert.match(human.out, /UI-2 · позиция 1/)
})

test('queue reorder пересобирает очередь по оценкам', (t) => {
  const dir = project(t)
  const { high, mid, low } = seedQueue(dir)
  json(dir, ['queue', 'move', low, '--top'])

  const reordered = json(dir, ['queue', 'reorder'])
  assert.deepEqual(
    reordered.map((card: { id: string }) => card.id),
    [high, mid, low],
  )
  assert.deepEqual(
    reordered.map((card: { position: number }) => card.position),
    [1, 2, 3],
  )

  const human = run(dir, ['queue', 'reorder'])
  assert.equal(human.code, 0, human.err)
  assert.match(human.out, /очередь пересобрана: 3/)
})

test('queue move отказывает без цели, с двумя целями и вне очереди', (t) => {
  const dir = project(t)
  const { high } = seedQueue(dir)

  const noTarget = run(dir, ['queue', 'move', high])
  assert.equal(noTarget.code, 3)
  assert.match(noTarget.err, /--before|--top|--bottom/)

  const both = run(dir, ['queue', 'move', high, '--top', '--bottom'])
  assert.equal(both.code, 3)
  assert.match(both.err, /одно/)

  const missing = run(dir, ['queue', 'move', 'UI-9', '--top'])
  assert.equal(missing.code, 3)
  assert.match(missing.err, /не найдена/)

  json(dir, ['card', 'add', '--group', 'UI', '--title', 'Запрос', '--skill', 'dev'])
  const notQueued = run(dir, ['queue', 'move', 'UI-4', '--top'])
  assert.equal(notQueued.code, 3)
  assert.match(notQueued.err, /не в очереди/)

  const usage = run(dir, ['queue', 'wat'])
  assert.equal(usage.code, 3)
  assert.match(usage.err, /использование/)
})
