import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { commitGenerated, makeRepo } from '../helpers/repo.ts'

const bin = resolve('bin/board.ts')

interface Result {
  code: number | null
  out: string
  err: string
}

/** Запускает настоящий CLI `board` в каталоге `dir`. */
function run(dir: string, args: string[]): Result {
  const result = spawnSync(process.execPath, [bin, ...args], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, BOARD_ALLOW_GLOBAL: '1' },
    windowsHide: true,
  })
  return { code: result.status, out: result.stdout ?? '', err: result.stderr ?? '' }
}

/** Успешная команда, которая возвращает JSON-объект. */
function json(dir: string, args: string[]): Record<string, any> {
  const result = run(dir, [...args, '--json'])
  assert.equal(result.code, 0, result.err)
  return JSON.parse(result.out)
}

/** git в произвольном каталоге (для коммита внутри worktree). */
function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, BOARD_ALLOW_GLOBAL: '1' },
    windowsHide: true,
  }).trim()
}

/** Временный git-репозиторий с инициализированной и закоммиченной доской. */
function project(t: { after: (fn: () => void) => void }): string {
  const repo = makeRepo()
  t.after(() => repo.close())
  const init = run(repo.root, ['init'])
  assert.equal(init.code, 0, init.err)
  // Старые e2e проверяют жизненный цикл, а не spec review.
  assert.equal(run(repo.root, ['setup', '--spec-review', 'none']).code, 0)
  commitGenerated(repo.root)
  return repo.root
}

test('полный цикл карточки через CLI: init → review → release', (t) => {
  const root = project(t)

  const executor = run(root, ['executor', 'add', 'developer', '--kind', 'agent', '--skills', 'dev'])
  assert.equal(executor.code, 0, executor.err)

  const card = json(root, ['card', 'add', '--group', 'UI', '--title', 'Форма', '--skill', 'dev'])
  assert.equal(card.id, 'UI-1')
  assert.equal(card.phase, 'request')
  assert.equal(card.status, 'new')

  assert.equal(run(root, ['card', 'shape', 'UI-1', '--as', 'owner']).code, 0)
  assert.equal(
    run(root, ['card', 'edit', 'UI-1', '--spec', 'Форма', '--acceptance', 'Форма работает', '--importance', '2', '--urgency', '3', '--scope', 'src/**', '--review']).code,
    0,
  )
  assert.equal(run(root, ['card', 'submit', 'UI-1', '--as', 'owner']).code, 0)
  assert.equal(run(root, ['card', 'approve', 'UI-1', '--as', 'owner']).code, 0)

  const ready = json(root, ['card', 'show', 'UI-1'])
  assert.equal(ready.status, 'ready')

  assert.equal(run(root, ['run', 'start', '--as', 'developer', '--cards', 'UI-1']).code, 0)
  assert.equal(
    run(root, ['card', 'step', 'add', 'UI-1', 'сделать форму', '--as', 'developer']).code,
    0,
  )
  assert.equal(run(root, ['take', 'UI-1', '--as', 'developer']).code, 0)

  // Работа в worktree исполнителя: коммит файла внутри scope src/**.
  const wt = join(root, '.worktrees', 'developer')
  mkdirSync(join(wt, 'src'), { recursive: true })
  writeFileSync(join(wt, 'src', 'app.ts'), 'export const x = 1\n')
  git(wt, ['add', '.'])
  git(wt, ['commit', '-m', 'add app'])

  const finished = json(root, ['finish', 'UI-1', '--as', 'developer', '--summary', 'готово'])
  assert.equal(finished.status, 'review')
  assert.equal(finished.inDev, true)

  assert.equal(run(root, ['run', 'end', '--as', 'developer']).code, 0)

  // Карточка в dev и на ревью: dev опережает main на 1.
  const inReview = json(root, ['now', '3'])
  assert.equal(inReview.header.devAhead, 1)
  assert.ok(inReview.queue.some((item: { id: string; status: string }) => item.id === 'UI-1' && item.status === 'review'))

  assert.equal(run(root, ['review', 'submit', 'UI-1', '--plan', 'done', '--verdict', 'done', '--reviewer', 'reviewer-1']).code, 0)
  assert.equal(
    run(root, ['review', 'package', '--verdict', 'done', '--reviewer', 'reviewer-1']).code,
    0,
  )

  const released = run(root, ['release'])
  assert.equal(released.code, 0, released.err)

  // После релиза dev больше не опережает main.
  const after = json(root, ['now', '3'])
  assert.equal(after.header.devAhead, 0)
})

test('owner-карточка закрывается без брони и забега', (t) => {
  const root = project(t)

  const card = json(root, ['card', 'add', '--group', 'OPS', '--title', 'Создать VK группу', '--skill', 'owner'])
  assert.equal(card.id, 'OPS-1')
  assert.equal(card.status, 'ready')

  const done = json(root, ['card', 'done', 'OPS-1', '--summary', 'готово'])
  assert.equal(done.status, 'done')
  assert.equal(done.needsMerge, false)
})

test('критическая находка ревью блокирует release', (t) => {
  const root = project(t)

  json(root, ['card', 'add', '--group', 'UI', '--title', 'Форма', '--skill', 'dev'])

  const finding = json(root, ['review', 'finding', 'UI-1', '--severity', 'critical', '--text', 'утечка памяти'])
  assert.equal(finding.severity, 'critical')
  assert.equal(finding.status, 'new')

  const released = run(root, ['release'])
  assert.equal(released.code, 2)
  assert.match(released.err, /находк/)
})

test('два процесса не бронируют одну карточку дважды', async (t) => {
  const root = project(t)
  run(root, ['executor', 'add', 'developer-1', '--kind', 'agent', '--skills', 'dev'])
  run(root, ['executor', 'add', 'developer-2', '--kind', 'agent', '--skills', 'dev'])

  const card = json(root, ['card', 'add', '--group', 'UI', '--title', 'Форма', '--skill', 'dev'])
  assert.equal(run(root, ['card', 'shape', card.id, '--as', 'owner']).code, 0)
  assert.equal(
    run(root, ['card', 'edit', card.id, '--spec', 'Форма', '--acceptance', 'Форма работает', '--importance', '2', '--urgency', '2', '--scope', 'src/**']).code,
    0,
  )
  assert.equal(run(root, ['card', 'submit', card.id, '--as', 'owner']).code, 0)
  assert.equal(run(root, ['card', 'approve', card.id, '--as', 'owner']).code, 0)

  const spawnBoard = (actor: string): Promise<Result> =>
    new Promise((resolvePromise) => {
      const child = spawn(process.execPath, [bin, 'run', 'start', '--as', actor, '--cards', card.id, '--json'], {
        cwd: root,
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

  const [first, second] = await Promise.all([spawnBoard('developer-1'), spawnBoard('developer-2')])

  assert.equal([first, second].filter((result) => result.code === 0).length, 1)
  assert.equal([first, second].filter((result) => result.code !== 0).length, 1)
})

test('забег с запросом: разбор и promotion', (t) => {
  const root = project(t)
  const req = json(root, [
    'card', 'add', '--group', 'NOW', '--title', 'Новое', '--skill', 'dev', '--tag', 'new',
    '--no-review', '--reason', 'тест promotion без ревью', '--as', 'owner',
  ])
  json(root, ['run', 'start', '--as', 'owner', '--cards', req.id])

  const next = json(root, ['run', 'next', '--as', 'owner'])
  assert.equal(next.phase, 'request')
  assert.equal(next.id, req.id)

  const shaped = json(root, ['take', req.id, '--as', 'owner'])
  assert.equal(shaped.status, 'shaping')

  run(root, [
    'card', 'edit', req.id,
    '--spec', 'spec',
    '--acceptance', 'ok',
    '--scope', 'src/**',
    '--importance', '2',
    '--urgency', '2',
  ])

  const promoted = json(root, ['take', req.id, '--as', 'owner'])
  assert.equal(promoted.phase, 'task')
  assert.equal(promoted.status, 'in_progress')
})
