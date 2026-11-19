import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { openDb } from '../../src/core/db.ts'
import { seedCard, seedExecutor } from '../helpers/board.ts'

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
  const dir = mkdtempSync(join(tmpdir(), 'board-now-'))
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

test('now --json: вкладка 3 по умолчанию, заголовок и секции', (t) => {
  const dir = project(t)
  const db = open(dir)
  seedCard(db, { phase: 'task', status: 'ready', position: 1 })
  seedCard(db)
  db.close()

  const data = json(dir, ['now'])
  assert.equal(data.view, 3)
  assert.equal(typeof data.header.doneToday, 'number')
  assert.equal(typeof data.header.devAhead, 'number')
  assert.equal(data.queue.length, 1)
  assert.equal(data.requests.length, 1)
})

test('now печатает заголовок вкладки и очередь', (t) => {
  const dir = project(t)
  const db = open(dir)
  seedCard(db, { phase: 'task', status: 'ready', position: 1 })
  db.close()

  const out = run(dir, ['now'])
  assert.equal(out.code, 0, out.err)
  assert.match(out.out, /\[3\] ОТКРЫТЫЕ КАРТОЧКИ/)
  assert.match(out.out, /СДЕЛАНО СЕГОДНЯ/)
  assert.match(out.out, /ОЧЕРЕДЬ \(1\)/)
})

test('now 0 --json: утвердить, задачи владельца и вопросы', (t) => {
  const dir = project(t)
  const db = open(dir)
  seedCard(db, { phase: 'task', status: 'approval', skill: 'dev', importance: 3, urgency: 2 })
  seedCard(db, { skill: 'owner', status: 'ready' })
  db.close()

  const data = json(dir, ['now', '0'])
  assert.equal(data.view, 0)
  assert.equal(data.approvals.length, 1)
  assert.equal(data.ownerCards.length, 1)
  assert.ok(Array.isArray(data.questions))
})

test('now 3: фильтры --group, --status, --skill и --mine через CLI', (t) => {
  const dir = project(t)
  const db = open(dir)
  seedExecutor(db, { id: 'developer', skills: ['dev'] })
  seedCard(db, { phase: 'task', status: 'ready', position: 1 }) // UI-1
  seedCard(db, { phase: 'task', status: 'ready', position: 2, group: 'IM', skill: 'marketing' }) // IM-1
  seedCard(db, { phase: 'task', status: 'blocked', position: 3, holder: 'developer', group: 'OPS' }) // OPS-1
  db.close()

  const byGroup = json(dir, ['now', '3', '--group', 'IM'])
  assert.deepEqual(byGroup.queue.map((card: { id: string }) => card.id), ['IM-1'])

  const bySkill = json(dir, ['now', '3', '--skill', 'marketing'])
  assert.deepEqual(bySkill.queue.map((card: { id: string }) => card.id), ['IM-1'])

  const byStatus = json(dir, ['now', '3', '--status', 'blocked'])
  assert.deepEqual(byStatus.queue.map((card: { id: string }) => card.id), ['OPS-1'])

  const mine = json(dir, ['now', '3', '--mine', '--as', 'developer'])
  assert.deepEqual(mine.queue.map((card: { id: string }) => card.id), ['OPS-1'])
})

test('now 1 и now 2 --json: предложения и забеги', (t) => {
  const dir = project(t)
  const db = open(dir)
  seedExecutor(db, { id: 'developer', skills: ['dev'] })
  seedExecutor(db, { id: 'marketer', skills: ['marketing'] })
  seedCard(db, { phase: 'task', status: 'ready', position: 1 })
  seedCard(db, { phase: 'task', status: 'ready', position: 2, skill: 'marketing', group: 'IM' })
  db.close()

  const one = json(dir, ['now', '1'])
  assert.equal(one.view, 1)
  assert.ok(Array.isArray(one.suggestions))

  const two = json(dir, ['now', '2'])
  assert.equal(two.view, 2)
  assert.ok(Array.isArray(two.runs))
})

test('now с неизвестной вкладкой — код 3', (t) => {
  const dir = project(t)
  const out = run(dir, ['now', '9'])
  assert.equal(out.code, 3)
  assert.match(out.err, /вкладка/)
})

test('now 3: --phase, --limit и --all через CLI', (t) => {
  const dir = project(t)
  const db = open(dir)
  for (let i = 1; i <= 3; i++) seedCard(db, { phase: 'task', status: 'ready', position: i })
  seedCard(db)
  seedCard(db)
  db.close()

  const phaseRequest = json(dir, ['now', '3', '--phase', 'request'])
  assert.equal(phaseRequest.requests.length, 2)
  assert.equal(phaseRequest.queue, undefined)

  const phaseTask = json(dir, ['now', '3', '--phase', 'task'])
  assert.equal(phaseTask.queue.length, 3)
  assert.equal(phaseTask.requests, undefined)

  const limited = json(dir, ['now', '3', '--limit', '1'])
  assert.equal(limited.queue.length, 1)
  assert.equal(limited.requests.length, 1)

  const all = json(dir, ['now', '3', '--all'])
  assert.equal(all.queue.length, 3)
  assert.equal(all.requests.length, 2)

  const bad = run(dir, ['now', '3', '--phase', 'wat'])
  assert.equal(bad.code, 3)
  assert.match(bad.err, /--phase/)
})
