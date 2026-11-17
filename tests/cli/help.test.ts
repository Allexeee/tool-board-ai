import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const bin = resolve('bin/toolbox-al.ts')

function run(args: string[]) {
  const result = spawnSync(process.execPath, [bin, ...args], {
    cwd: mkdtempSync(join(tmpdir(), 'al-help-')),
    encoding: 'utf8',
  })
  return { code: result.status, out: result.stdout, err: result.stderr }
}

test('help перечисляет все команды верхнего уровня', () => {
  const { code, out } = run(['help'])

  assert.equal(code, 0)
  for (const command of ['pool', 'upgrade', 'version', 'reopen', 'dispatch', 'request', 'feature', 'task', 'map']) {
    assert.match(out, new RegExp(command), command)
  }
})

test('help упоминает map и task context', () => {
  const { out } = run(['help'])

  assert.match(out, /^\s+map\b/m)
  assert.match(out, /task context/)
})

test('help показывает пример вызова dispatch', () => {
  const { out } = run(['--help'])
  assert.match(out, /пример: toolbox-al dispatch/)
})

test('неизвестная команда по-прежнему ошибка', () => {
  const { code, err } = run(['nonsense'])
  assert.equal(code, 3)
  assert.match(err, /неизвестная команда/)
})
