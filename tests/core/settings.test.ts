import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DEFAULT_SETTINGS,
  ensureSettings,
  readSettings,
  settingsPath,
  updateSettings,
} from '../../src/core/settings.ts'

function tempDir(t: { after: (fn: () => void) => void }): string {
  const dir = mkdtempSync(join(tmpdir(), 'board-settings-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

test('settings: по умолчанию ревью после забега выключено', (t) => {
  const root = tempDir(t)

  const first = ensureSettings(root)
  assert.equal(first.created, true)
  assert.deepEqual(first.settings, DEFAULT_SETTINGS)
  assert.equal(first.settings.reviewAfterRun, false)
  assert.ok(existsSync(settingsPath(root)))

  const second = ensureSettings(root)
  assert.equal(second.created, false)
  assert.deepEqual(second.settings, DEFAULT_SETTINGS)
})

test('settings: переключатель сохраняется и отмечает setupAt', (t) => {
  const root = tempDir(t)

  const on = updateSettings(root, { reviewAfterRun: true }, () => '2026-11-19T10:00:00.000Z')
  assert.equal(on.reviewAfterRun, true)
  assert.equal(on.setupAt, '2026-11-19T10:00:00.000Z')
  assert.equal(readSettings(root).reviewAfterRun, true)

  const off = updateSettings(root, { reviewAfterRun: false }, () => '2026-11-19T11:00:00.000Z')
  assert.equal(off.reviewAfterRun, false)
  assert.equal(off.setupAt, '2026-11-19T11:00:00.000Z')
  assert.deepEqual(readSettings(root), off)
  assert.equal(existsSync(`${settingsPath(root)}.tmp`), false)
})

test('settings: BOM читается, испорченный файл даёт дефолт', (t) => {
  const root = tempDir(t)
  const path = settingsPath(root)
  ensureSettings(root)

  writeFileSync(
    path,
    '\uFEFF' + JSON.stringify({ version: 1, reviewAfterRun: true, setupAt: '2026-11-19T12:00:00.000Z' }),
    'utf8',
  )
  assert.equal(readSettings(root).reviewAfterRun, true)
  assert.equal(readSettings(root).setupAt, '2026-11-19T12:00:00.000Z')

  writeFileSync(path, '{ не json', 'utf8')
  assert.deepEqual(readSettings(root), DEFAULT_SETTINGS)
})
