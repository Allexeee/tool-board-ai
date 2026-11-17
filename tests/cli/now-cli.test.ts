import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const bin = resolve('bin/toolbox-al.ts')

function run(dir: string, args: string[]) {
  const result = spawnSync(process.execPath, [bin, ...args], { cwd: dir, encoding: 'utf8' })
  return { code: result.status, out: result.stdout, err: result.stderr }
}

function project() {
  const dir = mkdtempSync(join(tmpdir(), 'al-now-'))
  run(dir, ['init'])
  return dir
}

test('now на пустом проекте говорит, что работы нет', () => {
  const dir = project()
  const view = run(dir, ['now'])

  assert.equal(view.code, 0, view.err)
  assert.match(view.out, /фич в работе нет/)
})

test('now прячет завершённые фичи, а --all показывает', () => {
  const dir = project()
  run(dir, ['feature', 'add', 'Сделано'])
  const db = new DatabaseSync(join(dir, '.toolbox-al/tracker.db'))
  db.prepare("update features set status = 'done' where id = 'F1'").run()
  db.close()

  const hidden = run(dir, ['now'])
  assert.doesNotMatch(hidden.out, /Сделано/)
  assert.match(hidden.out, /фич в работе нет/)

  const all = run(dir, ['now', '--all'])
  assert.match(all.out, /Сделано/)
})

test('now показывает фичу в работе', () => {
  const dir = project()
  run(dir, ['feature', 'add', 'В работе'])

  const view = run(dir, ['now'])
  assert.match(view.out, /В работе/)
})
