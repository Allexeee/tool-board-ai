import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { openDb } from '../../src/core/db.ts'
import { seedCard, seedExecutor } from '../helpers/board.ts'

const bin = resolve('bin/board.ts')
const ANSI = /\u001b\[[0-9;]*m/

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

test('now --json: по умолчанию вкладка 2 с задачами агентов', (t) => {
  const dir = project(t)
  const db = open(dir)
  seedExecutor(db, { id: 'developer', skills: ['dev'] })
  seedCard(db, { phase: 'task', status: 'in_progress', holder: 'developer' })
  seedCard(db, { phase: 'task', status: 'ready', position: 1 })
  db.close()

  const data = json(dir, ['now'])
  assert.equal(data.view, 2)
  assert.equal(typeof data.header.doneToday, 'number')
  assert.equal(typeof data.header.devAhead, 'number')
  assert.deepEqual(data.executors.map((item: { id: string }) => item.id), ['developer'])
  assert.equal(data.executors[0].current.length, 1)
  assert.equal(data.executors[0].queue.length, 1)
})

test('now печатает вкладку 2 по умолчанию', (t) => {
  const dir = project(t)
  const db = open(dir)
  seedExecutor(db, { id: 'developer', skills: ['dev'] })
  seedCard(db, { phase: 'task', status: 'ready', position: 1 })
  db.close()

  const out = run(dir, ['now'])
  assert.equal(out.code, 0, out.err)
  assert.match(out.out, /\[2\] ЗАДАЧИ ПО АГЕНТАМ/)
  assert.match(out.out, /developer/)
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

test('now 1 --json: только задачи указанного агента, без забегов', (t) => {
  const dir = project(t)
  const db = open(dir)
  seedExecutor(db, { id: 'developer', skills: ['dev'] })
  seedExecutor(db, { id: 'marketer', skills: ['marketing'] })
  seedCard(db, { phase: 'task', status: 'in_progress', holder: 'developer' })
  seedCard(db, { phase: 'task', status: 'ready', position: 1, skill: 'dev' })
  seedCard(db, { phase: 'task', status: 'ready', position: 2, skill: 'marketing', group: 'IM' })
  db.close()

  const data = json(dir, ['now', '1', '--as', 'developer'])
  assert.equal(data.view, 1)
  assert.equal(data.executor, 'developer')
  assert.deepEqual(data.skills, ['dev'])
  assert.equal(data.current.length, 1)
  assert.equal(data.queue.length, 1)
  assert.equal(data.suggestions, undefined)
  assert.equal(data.runs, undefined)
  assert.equal(data.currentRun, undefined)
})

test('now 2 --json: по блоку на агента', (t) => {
  const dir = project(t)
  const db = open(dir)
  seedExecutor(db, { id: 'developer', skills: ['dev'] })
  seedExecutor(db, { id: 'marketer', skills: ['marketing'] })
  seedCard(db, { phase: 'task', status: 'ready', position: 1, skill: 'dev' })
  seedCard(db, { phase: 'task', status: 'ready', position: 2, skill: 'marketing', group: 'IM' })
  db.close()

  const data = json(dir, ['now', '2', '--as', 'developer'])
  assert.equal(data.view, 2)
  assert.deepEqual(data.executors.map((item: { id: string }) => item.id), ['developer', 'marketer'])
  assert.equal('executor' in data, false)
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

test('now 3: отменённые запросы не показываются', (t) => {
  const dir = project(t)
  const db = open(dir)
  seedCard(db, { phase: 'request', status: 'new', title: 'Открытый' })
  seedCard(db, { phase: 'request', status: 'cancelled', title: 'Отменённый' })
  db.close()

  const data = json(dir, ['now', '3'])
  assert.deepEqual(data.requests.map((card: { title: string }) => card.title), ['Открытый'])
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

test('now не печатает ANSI в пайпе и в --json', (t) => {
  const dir = project(t)
  const db = open(dir)
  seedExecutor(db, { id: 'developer', skills: ['dev'] })
  seedCard(db, { phase: 'task', status: 'in_progress', holder: 'developer' })
  db.close()

  const pipe = run(dir, ['now', '2'])
  assert.equal(pipe.code, 0, pipe.err)
  assert.doesNotMatch(pipe.out, ANSI)

  const asJson = run(dir, ['now', '2', '--json'])
  assert.equal(asJson.code, 0, asJson.err)
  assert.doesNotMatch(asJson.out, ANSI)
})
