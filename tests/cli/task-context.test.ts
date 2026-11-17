import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const bin = resolve('bin/toolbox-al.ts')

function run(dir: string, args: string[]) {
  const result = spawnSync(process.execPath, [bin, ...args], { cwd: dir, encoding: 'utf8' })
  return { code: result.status, out: result.stdout, err: result.stderr }
}

test('task context печатает DoD и файлы области', () => {
  const dir = mkdtempSync(join(tmpdir(), 'al-ctx-cli-'))
  run(dir, ['init'])
  run(dir, ['task', 'add', 'Правка', '--dod', 'готово', '--skill', 'backend', '--scope', 'src/**'])
  mkdirSync(join(dir, 'src'), { recursive: true })
  writeFileSync(join(dir, 'src/a.ts'), 'a\nb')

  const shown = run(dir, ['task', 'context', 'T1'])
  assert.equal(shown.code, 0, shown.err)
  assert.match(shown.out, /DoD: готово/)
  assert.match(shown.out, /src\/a\.ts/)
  assert.match(shown.out, /2 стр\./)
})

test('task context без id объясняет использование', () => {
  const dir = mkdtempSync(join(tmpdir(), 'al-ctx-noid-'))
  run(dir, ['init'])

  const shown = run(dir, ['task', 'context'])
  assert.equal(shown.code, 3)
  assert.match(shown.err, /task context/)
})
