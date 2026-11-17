import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

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
