import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { editCard, getCard } from '../../src/core/cards.ts'
import { openDb } from '../../src/core/db.ts'
import { runGit } from '../../src/core/git.ts'
import { initProject } from '../../src/core/project.ts'
import { getActiveRun, listRunCards } from '../../src/core/runs.ts'
import { updateSettings } from '../../src/core/settings.ts'
import { recordSpecReview } from '../../src/core/spec-review.ts'
import { makeBoard, seedCard, seedExecutor } from '../helpers/board.ts'
import { commitGenerated, makeRepo } from '../helpers/repo.ts'

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

function json(dir: string, args: string[]): Record<string, unknown> {
  const result = run(dir, [...args, '--json'])
  assert.equal(result.code, 0, result.err)
  return JSON.parse(result.out) as Record<string, unknown>
}

/** Проект с git-репозиторием, исполнителем developer и карточкой в scope src/**. */
function repoProject(t: { after: (fn: () => void) => void }): { root: string; cardId: string } {
  const repo = makeRepo()
  initProject(repo.root)
  commitGenerated(repo.root)
  const db = openDb(join(repo.root, '.board', 'board.db'))
  seedExecutor(db, { id: 'developer', skills: ['dev'] })
  const card = seedCard(db, {
    phase: 'task',
    status: 'ready',
    position: 1,
    scope: ['src/**'],
  })
  db.close()
  t.after(() => repo.close())
  return { root: repo.root, cardId: card.id }
}

test('take → finish через CLI мержит в dev', (t) => {
  const { root, cardId } = repoProject(t)

  const started = run(root, ['run', 'start', '--as', 'developer', '--cards', cardId])
  assert.equal(started.code, 0, started.err)

  const taken = json(root, ['take', cardId, '--as', 'developer'])
  assert.equal(taken.status, 'in_progress')
  assert.ok(taken.branch)

  const wt = join(root, '.worktrees', 'developer')
  mkdirSync(join(wt, 'src'), { recursive: true })
  writeFileSync(join(wt, 'src', 'app.ts'), 'export const x = 1\n')
  runGit(wt, ['add', '.'])
  runGit(wt, ['commit', '-m', 'add app'])

  const finished = json(root, ['finish', cardId, '--as', 'developer', '--summary', 'готово'])
  assert.equal(finished.status, 'done')
  assert.ok(finished.mergeCommit)
  assert.equal(finished.inDev, true)
})

test('finish без --as и --summary отказывает', (t) => {
  const { root, cardId } = repoProject(t)
  run(root, ['run', 'start', '--as', 'developer', '--cards', cardId])
  json(root, ['take', cardId, '--as', 'developer'])

  const noActor = run(root, ['finish', cardId])
  assert.equal(noActor.code, 3)
  assert.match(noActor.err, /--as/)

  const noSummary = run(root, ['finish', cardId, '--as', 'developer'])
  assert.equal(noSummary.code, 3)
  assert.match(noSummary.err, /отчёт/)
})

test('block помечает run_cards blocked, run next берёт следующую', (t) => {
  const fixture = makeBoard()
  t.after(fixture.close)
  seedExecutor(fixture.db, { id: 'developer', skills: ['dev'] })
  const first = seedCard(fixture.db, { phase: 'task', status: 'ready', position: 1 })
  const second = seedCard(fixture.db, { phase: 'task', status: 'ready', position: 2 })
  editCard(fixture.db, { id: first.id, actor: 'owner', patch: { needsMerge: false } })
  editCard(fixture.db, { id: second.id, actor: 'owner', patch: { needsMerge: false } })

  json(fixture.root, ['run', 'start', '--as', 'developer', '--cards', `${first.id},${second.id}`])
  json(fixture.root, ['take', first.id, '--as', 'developer'])

  const blocked = json(fixture.root, [
    'block', first.id, '--as', 'developer', '--reason', 'needs_decision', '--note', 'какой SSO?',
  ])
  assert.equal(blocked.status, 'blocked')

  const run = getActiveRun(fixture.db, 'developer')!
  assert.equal(listRunCards(fixture.db, run.id).find((row) => row.cardId === first.id)!.status, 'blocked')

  const next = json(fixture.root, ['run', 'next', '--as', 'developer'])
  assert.equal(next.id, second.id)
})

test('ask --block задаёт вопрос и блокирует карточку', (t) => {
  const fixture = makeBoard()
  t.after(fixture.close)
  const card = seedCard(fixture.db, {})

  const question = json(fixture.root, ['ask', card.id, 'Нужен ли SSO?', '--as', 'developer', '--block'])
  assert.equal(question.kind, 'question')
  assert.equal(getCard(fixture.db, card.id)!.status, 'blocked')
})

test('touch продлевает lease через CLI', (t) => {
  const fixture = makeBoard()
  t.after(fixture.close)
  seedExecutor(fixture.db, { id: 'developer', skills: ['dev'] })
  const card = seedCard(fixture.db, { phase: 'task', status: 'ready', position: 1 })
  editCard(fixture.db, { id: card.id, actor: 'owner', patch: { needsMerge: false } })

  json(fixture.root, ['run', 'start', '--as', 'developer', '--cards', card.id])
  json(fixture.root, ['take', card.id, '--as', 'developer'])
  fixture.db
    .prepare("update runs set lease_until = '2000-01-01T00:00:00.000Z' where executor_id = 'developer'")
    .run()

  const touched = json(fixture.root, ['touch', card.id, '--as', 'developer'])
  assert.ok((touched.leaseUntil as string) > '2000-01-01T00:00:00.000Z')
  assert.equal(getActiveRun(fixture.db, 'developer')!.leaseUntil, touched.leaseUntil)
})

test('take: 600-словный spec требует spec review subagent', (t) => {
  const repo = makeRepo()
  initProject(repo.root)
  commitGenerated(repo.root)
  const db = openDb(join(repo.root, '.board', 'board.db'))
  t.after(() => {
    db.close()
    repo.close()
  })
  seedExecutor(db, { id: 'developer', skills: ['dev'] })
  updateSettings(repo.root, {
    reviewer: { model: 'opencode-go/deepseek-v4.1-flash' },
    review: { profile: 'default' },
  })

  const card = seedCard(db, {
    phase: 'request',
    status: 'new',
    skill: 'dev',
    importance: 2,
    urgency: 2,
    scope: ['src/**'],
  })
  const started = run(repo.root, ['run', 'start', '--cards', card.id, '--as', 'developer'])
  assert.equal(started.code, 0, started.err)
  const shaped = run(repo.root, ['take', card.id, '--as', 'developer'])
  assert.equal(shaped.code, 0, shaped.err)

  // Профиль default требует субагента с 500 слов: берём заведомо больше порога.
  const words = Array.from({ length: 600 }, () => 'слово').join(' ')
  db.prepare('update cards set body = ?, acceptance = ? where id = ?').run(words, 'ok', card.id)
  // Self-ревью есть; если take не передаст текст spec, гейт останется self и пропустит.
  recordSpecReview(db, { cardId: card.id, reviewer: 'reviewer', mode: 'self', verdict: 'done' })

  const result = run(repo.root, ['take', card.id, '--as', 'developer'])
  assert.equal(result.code, 2, result.err)
  assert.match(result.err, /субагента/)
})
