import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readConfig, saveConfig } from '../../src/core/config.ts'
import { UserError } from '../../src/cli/errors.ts'

const tmp = () => mkdtempSync(join(tmpdir(), 'al-cfg-'))

const sample = { toolVersion: '1.0.2', leaseMinutes: 30, branches: { main: 'main', dev: 'dev' } }

test('конфиг с BOM читается', () => {
  const dir = tmp()
  const path = join(dir, 'config.json')
  writeFileSync(path, '\uFEFF' + JSON.stringify(sample), 'utf8')

  const config = readConfig(path)
  assert.equal(config.toolVersion, '1.0.2')
  assert.equal(config.leaseMinutes, 30)
})

test('битый конфиг даёт UserError без стектрейса', () => {
  const dir = tmp()
  const path = join(dir, 'config.json')
  writeFileSync(path, '{ "toolVersion": ', 'utf8')

  assert.throws(
    () => readConfig(path),
    (error: unknown) => error instanceof UserError && /повреждён/.test((error as Error).message),
  )
})

test('saveConfig сохраняет BOM, если он был', () => {
  const dir = tmp()
  const path = join(dir, 'config.json')
  writeFileSync(path, '\uFEFF' + JSON.stringify(sample), 'utf8')

  saveConfig(path, { ...sample, toolVersion: '2.0.0' })

  const raw = readFileSync(path, 'utf8')
  assert.equal(raw.startsWith('\uFEFF'), true)
  assert.match(raw, /2\.0\.0/)
})
