import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
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
    windowsHide: true,
  })
  return { code: result.status, out: result.stdout ?? '', err: result.stderr ?? '' }
}

function ok(dir: string, args: string[]): Result {
  const result = run(dir, args)
  assert.equal(result.code, 0, result.err || result.out)
  return result
}

function json(dir: string, args: string[]): any {
  return JSON.parse(ok(dir, [...args, '--json']).out)
}

test('spec → plan → run review → findings → fix run', (t) => {
  const repo = makeRepo()
  t.after(() => repo.close())
  const root = repo.root

  ok(root, ['init'])
  commitGenerated(root)
  ok(root, [
    'setup',
    '--spec-review', 'self',
    '--run-review', 'subagent',
    '--reviewer-model', 'acme/reviewer',
  ])
  ok(root, ['executor', 'add', 'developer', '--kind', 'agent', '--skills', 'dev'])

  const cards = ['UI-1', 'UI-2', 'UI-3']
  for (const [index, id] of cards.entries()) {
    ok(root, ['card', 'add', '--group', 'UI', '--title', `Задача ${index + 1}`, '--skill', 'dev'])
    ok(root, ['card', 'shape', id, '--as', 'developer'])
    ok(root, [
      'card', 'edit', id,
      '--spec', `Проблема ${index + 1}`,
      '--acceptance', `Критерий ${index + 1}`,
      '--importance', '2',
      '--urgency', '2',
      '--no-needs-merge',
    ])
    ok(root, ['card', 'spec-review', id, '--as', 'developer', '--mode', 'self', '--verdict', 'done'])
    ok(root, ['card', 'submit', id, '--as', 'developer'])
    ok(root, ['card', 'approve', id, '--as', 'owner'])
  }

  const started = json(root, ['run', 'start', '--as', 'developer', '--cards', cards.join(',')])
  assert.equal(started.reviewMode, 'subagent')

  for (const id of cards) {
    ok(root, ['take', id, '--as', 'developer'])
    ok(root, ['card', 'step', 'add', id, `Шаг ${id} + тест`])
    const finished = json(root, ['finish', id, '--as', 'developer', '--summary', 'готово'])
    assert.equal(finished.status, 'review')
  }

  const ended = json(root, ['run', 'end', '--as', 'developer'])
  assert.equal(ended.review, true)
  assert.equal(ended.reviewMode, 'subagent')
  assert.equal(ended.reviewCards, 3)

  const review = json(root, ['review', 'list'])
  assert.equal(review.length, 3)
  assert.equal(review[0].spec, 'Проблема 1')
  assert.equal(review[0].acceptance, 'Критерий 1')
  assert.equal(review[0].plan[0].text, 'Шаг UI-1 + тест')

  const critical = json(root, [
    'review', 'finding', 'UI-1',
    '--severity', 'critical',
    '--text', 'утечка',
  ])
  const important = json(root, [
    'review', 'finding', 'UI-2',
    '--severity', 'important',
    '--text', 'добавить доку',
  ])
  json(root, ['review', 'finding', 'UI-3', '--severity', 'other', '--text', 'стиль'])

  for (const id of cards) {
    const submitted = json(root, [
      'review', 'submit', id,
      '--plan', 'done',
      '--verdict', 'done',
      '--reviewer', 'review',
    ])
    assert.equal(submitted.card.status, 'done')
  }
  assert.deepEqual(json(root, ['review', 'list']), [])

  const blocked = run(root, ['release'])
  assert.equal(blocked.code, 2)
  assert.match(blocked.err, /критическ/)

  // important/other не блокируют release, critical блокирует.
  ok(root, ['card', 'cancel', critical.id, '--reason', 'не актуально', '--as', 'owner'])
  ok(root, ['release'])

  // Finding-карточка проходит те же spec/plan-гейты и может стать fix run.
  ok(root, ['card', 'shape', important.id, '--as', 'developer'])
  ok(root, [
    'card', 'edit', important.id,
    '--spec', 'Исправить замечание',
    '--acceptance', 'Замечание закрыто',
    '--importance', '2',
    '--urgency', '2',
    '--no-needs-merge',
  ])
  ok(root, ['card', 'spec-review', important.id, '--as', 'developer', '--mode', 'self', '--verdict', 'done'])
  ok(root, ['card', 'submit', important.id, '--as', 'developer'])
  ok(root, ['card', 'approve', important.id, '--as', 'owner'])

  const fixRun = json(root, ['run', 'start', '--as', 'developer', '--cards', important.id])
  assert.equal(fixRun.reviewMode, 'subagent')
  const fixEnded = json(root, ['run', 'end', '--as', 'developer', '--no-review'])
  assert.equal(fixEnded.review, false)
  assert.equal(fixEnded.reviewMode, 'none')
})
