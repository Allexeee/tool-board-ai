import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { toolRoot, toolVersion } from '../../src/core/version.ts'
import { DEFAULT_CONFIG } from '../../src/core/config.ts'
import { pluginSource, writeOpenCodeFiles } from '../../src/core/opencode.ts'

test('версия инструмента берётся из package.json', () => {
  const pkg = JSON.parse(readFileSync(join(toolRoot, 'package.json'), 'utf8')) as { version: string }

  assert.equal(toolVersion(), pkg.version)
  assert.equal(toolVersion(toolRoot), pkg.version)
})

test('свежий init закрепляет ту же версию, что в package.json', () => {
  assert.equal(DEFAULT_CONFIG.toolVersion, toolVersion())
})

test('плагин по умолчанию объявляет версию из package.json', () => {
  assert.match(pluginSource(), new RegExp(`toolbox-al-plugin-version: ${toolVersion()}`))
})

test('смена package.json меняет версию без правок кода', () => {
  const dir = mkdtempSync(join(tmpdir(), 'al-ver-'))
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ version: '42.0.0' }), 'utf8')

  assert.equal(toolVersion(dir), '42.0.0')

  const root = mkdtempSync(join(tmpdir(), 'al-ver-oc-'))
  writeOpenCodeFiles(root, toolVersion(dir))
  const plugin = readFileSync(
    join(root, '.opencode/plugins/toolbox-al/index.ts'),
    'utf8',
  )
  assert.match(plugin, /42\.0\.0/)
})
