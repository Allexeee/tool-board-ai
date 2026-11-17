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
  const dir = mkdtempSync(join(tmpdir(), 'al-rel-'))
  run(dir, ['init'])
  return dir
}

test('release без уровня подсказывает и ничего не выпускает', () => {
  const dir = project()

  const shown = run(dir, ['release'])
  assert.equal(shown.code, 1)
  assert.match(shown.out, /нет слитых этапов/)

  const list = run(dir, ['version'])
  assert.match(list.out, /1\.0\.2|1\.0\.3/)
})

test('release без причины отвергается', () => {
  const dir = project()

  const strict = run(dir, ['release', 'minor'])
  assert.equal(strict.code, 3)
  assert.match(strict.err, /нужна причина/)
})

test('явный мусор вместо уровня отвергается', () => {
  const dir = project()

  const bad = run(dir, ['release', 'huge', '--reason', 'x'])
  assert.equal(bad.code, 3)
  assert.match(bad.err, /major\|minor\|patch/)
})

test('release показывает три варианта ревью', () => {
  const dir = project()
  run(dir, ['request', 'add', 'Оплата'])
  run(dir, ['feature', 'add', 'Оплата', '--request', 'R1'])
  run(dir, ['stage', 'add', 'F1', 'S1', '--goal', 'g', '--appetite', '1 день'])
  const db = new DatabaseSync(join(dir, '.toolbox-al/tracker.db'))
  db.prepare("update stages set status = 'merged', merged_at = ? where id = 'F1.S1'").run(
    new Date().toISOString(),
  )
  db.close()

  const shown = run(dir, ['release'])

  assert.match(shown.out, /РЕВЬЮ/)
  assert.match(shown.out, /--review same/)
  assert.match(shown.out, /--review fresh/)
  assert.match(shown.out, /--review none/)
  assert.match(shown.out, /ПОСЛЕ РЕВЬЮ/)
  assert.match(shown.out, /критические находки/i)
  assert.match(shown.out, /request add/)
})

test('release без выбора ревью отвергается', () => {
  const dir = project()
  const result = run(dir, ['release', 'minor', '--reason', 'x'])

  assert.equal(result.code, 3)
  assert.match(result.err, /--review same/)
})

test('неизвестный вариант ревью отвергается', () => {
  const dir = project()
  const result = run(dir, ['release', 'minor', '--reason', 'x', '--review', 'fast'])

  assert.equal(result.code, 3)
  assert.match(result.err, /same, fresh или none/)
})

