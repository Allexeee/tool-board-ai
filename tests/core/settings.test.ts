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

const isInputError = (error: { code?: number }) => error.code === 3

test('settings: v2 defaults', (t) => {
  const root = tempDir(t)

  const first = ensureSettings(root)
  assert.equal(first.created, true)
  assert.deepEqual(first.settings, DEFAULT_SETTINGS)
  assert.equal(first.settings.reviewer.model, null)
  assert.equal(first.settings.specReview.mode, 'auto')
  assert.equal(first.settings.specReview.maxSpecChars, 1500)
  assert.equal(first.settings.specReview.largeSpecChars, 6000)
  assert.equal(first.settings.runReview.mode, 'none')
  assert.ok(existsSync(settingsPath(root)))

  const second = ensureSettings(root)
  assert.equal(second.created, false)
  assert.deepEqual(second.settings, DEFAULT_SETTINGS)
})

test('settings: вложенное обновление сохраняет остальные поля', (t) => {
  const root = tempDir(t)

  const first = updateSettings(
    root,
    {
      reviewer: { model: 'opencode-go/deepseek-v4.1-flash' },
      specReview: { mode: 'self', maxSpecChars: 2000, largeSpecChars: 4000 },
      runReview: { mode: 'subagent' },
    },
    () => '2026-11-21T10:00:00.000Z',
  )
  assert.equal(first.setupAt, '2026-11-21T10:00:00.000Z')
  assert.equal(first.reviewer.model, 'opencode-go/deepseek-v4.1-flash')

  const second = updateSettings(root, { runReview: { mode: 'none' } }, () => '2026-11-21T11:00:00.000Z')
  assert.equal(second.specReview.mode, 'self')
  assert.equal(second.specReview.maxSpecChars, 2000)
  assert.equal(second.specReview.largeSpecChars, 4000)
  assert.equal(second.reviewer.model, 'opencode-go/deepseek-v4.1-flash')
  assert.equal(second.runReview.mode, 'none')
  assert.deepEqual(readSettings(root), second)
  assert.equal(existsSync(`${settingsPath(root)}.tmp`), false)
})

test('settings: v1 мигрирует в v2', (t) => {
  const root = tempDir(t)
  const path = settingsPath(root)
  ensureSettings(root)

  writeFileSync(
    path,
    JSON.stringify({ version: 1, reviewAfterRun: true, setupAt: '2026-01-01T00:00:00.000Z' }),
    'utf8',
  )
  const enabled = readSettings(root)
  assert.equal(enabled.version, 2)
  assert.equal(enabled.runReview.mode, 'subagent')
  assert.equal(enabled.specReview.mode, 'auto')
  assert.equal(enabled.specReview.maxSpecChars, 1500)
  assert.equal(enabled.specReview.largeSpecChars, 6000)
  assert.equal(enabled.reviewer.model, null)
  assert.equal(enabled.setupAt, '2026-01-01T00:00:00.000Z')

  writeFileSync(path, JSON.stringify({ version: 1, reviewAfterRun: false }), 'utf8')
  assert.equal(readSettings(root).runReview.mode, 'none')
})

test('settings: v2 без maxSpecChars получает 1500', (t) => {
  const root = tempDir(t)
  ensureSettings(root)
  writeFileSync(
    settingsPath(root),
    JSON.stringify({
      version: 2,
      reviewer: { model: null },
      specReview: { mode: 'auto', largeSpecChars: 4000 },
      runReview: { mode: 'none' },
      setupAt: null,
    }),
    'utf8',
  )

  const settings = readSettings(root)
  assert.equal(settings.specReview.maxSpecChars, 1500)
  assert.equal(settings.specReview.largeSpecChars, 4000)
})

test('settings: невалидные значения отклоняются', (t) => {
  const root = tempDir(t)
  ensureSettings(root)

  assert.throws(
    () => updateSettings(root, { specReview: { mode: 'sometimes' as never } }),
    isInputError,
  )
  assert.throws(
    () => updateSettings(root, { runReview: { mode: 'sometimes' as never } }),
    isInputError,
  )
  assert.throws(
    () => updateSettings(root, { specReview: { largeSpecChars: -1 } }),
    isInputError,
  )
  assert.throws(
    () => updateSettings(root, { specReview: { maxSpecChars: -1 } }),
    isInputError,
  )
  assert.throws(
    () => updateSettings(root, { reviewer: { model: 'bad-model' } }),
    isInputError,
  )
  assert.throws(
    () => updateSettings(root, { reviewer: { model: 'provider/model#max' } }),
    isInputError,
  )
})

test('settings: BOM читается, испорченный файл даёт дефолт', (t) => {
  const root = tempDir(t)
  const path = settingsPath(root)
  ensureSettings(root)

  writeFileSync(
    path,
    '\uFEFF' + JSON.stringify({
      version: 2,
      reviewer: { model: 'opencode-go/deepseek-v4.1-flash' },
      specReview: { mode: 'self', largeSpecChars: 4000 },
      runReview: { mode: 'subagent' },
      setupAt: '2026-11-21T12:00:00.000Z',
    }),
    'utf8',
  )
  assert.equal(readSettings(root).specReview.mode, 'self')
  assert.equal(readSettings(root).specReview.maxSpecChars, 1500)
  assert.equal(readSettings(root).reviewer.model, 'opencode-go/deepseek-v4.1-flash')

  writeFileSync(path, '{ не json', 'utf8')
  assert.deepEqual(readSettings(root), DEFAULT_SETTINGS)
})
