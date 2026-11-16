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

test('version печатает версию инструмента, схему и закреплённую версию', () => {
  const dir = mkdtempSync(join(tmpdir(), 'al-ver-cli-'))
  assert.equal(run(dir, ['init']).code, 0)

  const result = run(dir, ['version'])
  assert.equal(result.code, 0)
  assert.match(result.out, /toolbox-al \d+\.\d+\.\d+/)
  assert.match(result.out, /схема \d+/)
  assert.match(result.out, /закреплён/)
})

test('version --json отдаёт объект с tool, schema и available', () => {
  const dir = mkdtempSync(join(tmpdir(), 'al-ver-json-'))
  run(dir, ['init'])

  const result = run(dir, ['version', '--json'])
  assert.equal(result.code, 0)

  const data = JSON.parse(result.out) as { tool: string; schema: number; available: string[] }
  assert.match(data.tool, /^\d+\.\d+\.\d+$/)
  assert.equal(typeof data.schema, 'number')
  assert.ok(Array.isArray(data.available))
})

test('version вне проекта даёт код 3', () => {
  const dir = mkdtempSync(join(tmpdir(), 'al-ver-none-'))
  const result = run(dir, ['version'])
  assert.equal(result.code, 3)
  assert.match(result.err, /проект не найден/)
})
