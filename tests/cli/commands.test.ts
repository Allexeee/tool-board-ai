import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { runInit } from '../../src/cli/commands/init.ts'

const bin = resolve('bin/toolbox-al.ts')
const tmp = () => mkdtempSync(join(tmpdir(), 'tbal-cli-'))

function run(dir: string, args: string[]) {
  const result = spawnSync(process.execPath, [bin, ...args], { cwd: dir, encoding: 'utf8' })
  return { code: result.status, out: result.stdout, err: result.stderr }
}

test('вопрос задаётся и закрывается через CLI', () => {
  const dir = tmp()
  assert.equal(run(dir, ['init']).code, 0)
  assert.equal(run(dir, ['request', 'add', 'Оплата подписки']).code, 0)

  const asked = run(dir, ['ask', 'R1', 'ЮKassa или Stripe?', '--to', 'owner'])
  assert.equal(asked.code, 0)

  const answered = run(dir, ['answer', 'Q1', 'ЮKassa'])
  assert.equal(answered.code, 0)

  const inbox = run(dir, ['inbox'])
  assert.equal(inbox.out.includes('ЮKassa'), false)
})

test('hand show и hand set работают', () => {
  const dir = tmp()
  run(dir, ['init'])
  run(dir, ['executor', 'add', 'w1', '--skills', 'backend'])

  const shown = run(dir, ['hand', 'show', '--as', 'w1'])
  assert.equal(shown.code, 0)
  assert.match(shown.out, /пусто|рука/i)
})

test('hand show ничего не резервирует', () => {
  const dir = tmp()
  run(dir, ['init'])
  run(dir, ['executor', 'add', 'w1', '--skills', 'backend'])
  run(dir, ['task', 'add', 'Пул', '--dod', 'сделано', '--skill', 'backend', '--scope', 'src/**'])

  const shown = run(dir, ['hand', 'show', '--as', 'w1'])
  assert.equal(shown.code, 0)
  assert.match(shown.out, /рука пуста/)

  const db = new DatabaseSync(join(dir, '.toolbox-al', 'tracker.db'))
  const reserved = db.prepare('select count(*) as c from hand').get() as { c: number }
  db.close()
  assert.equal(reserved.c, 0)
})

test('task show печатает тот же статус, что list', () => {
  const dir = tmp()
  run(dir, ['init'])
  run(dir, ['task', 'add', 'Пул', '--dod', 'сделано', '--skill', 'backend', '--scope', 'src/**'])

  const shown = run(dir, ['task', 'show', 'T1'])
  const listed = run(dir, ['task', 'list'])
  assert.equal(shown.code, 0)
  assert.match(shown.out, /статус: ready/)
  assert.match(listed.out, /ready/)
})

test('release pending на свежем проекте говорит, что релизить нечего', () => {
  const dir = tmp()
  run(dir, ['init'])

  const pending = run(dir, ['release', 'pending'])
  assert.equal(pending.code, 0)
  assert.match(pending.out, /нечего релизить/)
})

test('feature clean сообщает причину и возвращает код 1, если каталог остался', () => {
  const dir = tmp()
  run(dir, ['init'])
  run(dir, ['feature', 'add', 'Оплата'])
  const outside = mkdtempSync(join(tmpdir(), 'al-keep-'))
  const db = new DatabaseSync(join(dir, '.toolbox-al', 'tracker.db'))
  db.prepare("update features set status = 'done', worktree = ? where id = 'F1'").run(outside)
  db.close()

  const cleaned = run(dir, ['feature', 'clean', 'F1'])
  assert.equal(cleaned.code, 1)
  assert.match(cleaned.out + cleaned.err, /вне \.worktrees|каталог остался/)
})

test('init подсказывает закоммитить скелет в git-репозитории', () => {
  const dir = mkdtempSync(join(tmpdir(), 'al-init-git-'))
  execFileSync('git', ['init', '-q'], { cwd: dir })

  const text = runInit(dir)

  assert.match(text, /git add/)
  assert.match(text, /git commit/)
})

test('init --dry-run ничего не создаёт', () => {
  const dir = tmp()
  const result = run(dir, ['init', '--dry-run'])
  assert.equal(result.code, 0)
  assert.match(result.out, /Ничего не изменено/)
  assert.equal(existsSync(join(dir, '.toolbox-al')), false)
})

test('done без аргументов отвечает кодом 3, а не падает', () => {
  const dir = tmp()
  run(dir, ['init'])
  const result = run(dir, ['done'])
  assert.equal(result.code, 3)
  assert.match(result.err, /использование/)
})





test('init подсказывает создать dev, если её нет', () => {
  const dir = mkdtempSync(join(tmpdir(), 'al-init-dev-'))
  execFileSync('git', ['init', '-q'], { cwd: dir })

  const text = runInit(dir)
  assert.match(text, /git branch dev/)
})
