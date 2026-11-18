import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { toolVersion } from '../../src/core/version.ts'

const bin = resolve('bin/toolbox-al.ts')

function run(dir: string, args: string[]) {
  const result = spawnSync(process.execPath, [bin, ...args], { cwd: dir, encoding: 'utf8', windowsHide: true })
  return { code: result.status, out: result.stdout, err: result.stderr }
}

test('upgrade --pin возвращает закрепление на установленную версию', () => {
  const dir = mkdtempSync(join(tmpdir(), 'al-pin-'))
  run(dir, ['init'])
  const configPath = join(dir, '.toolbox-al/config.json')
  const config = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>
  writeFileSync(configPath, JSON.stringify({ ...config, toolVersion: '9.9.9' }), 'utf8')

  const pinned = run(dir, ['upgrade', '--pin'])

  assert.equal(pinned.code, 0, pinned.err)
  const after = JSON.parse(readFileSync(configPath, 'utf8')) as { toolVersion: string }
  assert.equal(after.toolVersion, toolVersion())
})
