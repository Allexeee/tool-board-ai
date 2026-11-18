import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { openDb } from '../../src/core/db.ts'
import { addDep } from '../../src/core/deps.ts'

const bin = resolve('bin/toolbox-al.ts')
const flags = ['--dod', 'шаг сделан', '--size', 'XS', '--skill', 'backend', '--scope', 'src/**']

function run(dir: string, args: string[]) {
  const result = spawnSync(process.execPath, [bin, ...args], { cwd: dir, encoding: 'utf8', windowsHide: true })
  return { code: result.status, out: result.stdout ?? '', err: result.stderr ?? '' }
}

function git(dir: string, args: string[]) {
  execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
}

/**
 * Цепочка из двух шагов в руке: T2 зависит от T1.
 * Рука хранит оба шага заранее, поэтому take без id должен брать только разрешённый.
 */
function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'al-take-'))
  execFileSync('git', ['init', '-q'], { cwd: dir, windowsHide: true })
  git(dir, ['config', 'user.email', 't@e.x'])
  git(dir, ['config', 'user.name', 'T'])
  writeFileSync(join(dir, 'README.md'), 'x')
  git(dir, ['add', '.'])
  git(dir, ['commit', '-q', '-m', 'init'])
  // done задачи пула коммитит в корне: ветка main для него запрещена
  git(dir, ['checkout', '-q', '-b', 'dev'])

  run(dir, ['init'])
  run(dir, ['executor', 'add', 'w1', '--skills', 'backend'])
  git(dir, ['add', '.'])
  // dev защищён хуком init: настройка проекта — не задача, разрешаем явно
  execFileSync('git', ['commit', '-q', '-m', 'setup'], {
    cwd: dir,
    env: { ...process.env, AL_ALLOW: '1' },
    windowsHide: true,
  })

  run(dir, ['task', 'add', 'Первый шаг', ...flags])
  run(dir, ['task', 'add', 'Второй шаг', ...flags])

  const db = openDb(join(dir, '.toolbox-al', 'tracker.db'))
  addDep(db, 'T2', 'T1')
  db.close()

  const hand = run(dir, ['hand', 'set', 'T1', 'T2', '--as', 'w1'])
  assert.equal(hand.code, 0, hand.err)

  return dir
}

test('take без id берёт первый готовый шаг, а после done — следующий', () => {
  const dir = repo()

  const first = run(dir, ['take', '--as', 'w1'])
  assert.equal(first.code, 0, first.err)
  assert.match(first.out, /T1\s+Первый шаг/)

  mkdirSync(join(dir, 'src'), { recursive: true })
  writeFileSync(join(dir, 'src/a.ts'), 'a')
  const closed = run(dir, ['done', 'T1', '--as', 'w1', '--summary', 'шаг сделан'])
  assert.equal(closed.code, 0, closed.err)

  // новых команд для разблокировки не нужно: готовность пересчитывает само взятие
  const second = run(dir, ['take', '--as', 'w1'])
  assert.equal(second.code, 0, second.err)
  assert.match(second.out, /T2\s+Второй шаг/)
})

test('next обходит будущий шаг цепочки и показывает готовый', () => {
  const dir = repo()

  const next = run(dir, ['next', '--as', 'w1'])
  assert.equal(next.code, 0, next.err)
  assert.match(next.out, /T1\s+XS\s+Первый шаг/)
  assert.doesNotMatch(next.out, /T2/)
})

test('take без id объясняет, какого шага ждёт рука', () => {
  const dir = repo()

  // лимит WIP поднят, иначе отказ был бы про лимит, а не про ожидание зависимости
  const db = openDb(join(dir, '.toolbox-al', 'tracker.db'))
  db.prepare("update executors set wip_limit = 2 where id = 'w1'").run()
  db.close()

  const first = run(dir, ['take', '--as', 'w1'])
  assert.equal(first.code, 0, first.err)
  assert.match(first.out, /T1\s+Первый шаг/)

  const second = run(dir, ['take', '--as', 'w1'])
  assert.equal(second.code, 1)
  assert.match(second.err, /T2 ждёт T1/)
})
