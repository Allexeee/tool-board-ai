import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { ensureSettings, readSettings, type BoardSettings } from '../../src/core/settings.ts'
import {
  runSetupWizard,
  shouldRunSetup,
  type SetupDecision,
} from '../../src/cli/setup-wizard.ts'

function tempDir(t: { after: (fn: () => void) => void }): string {
  const dir = mkdtempSync(join(tmpdir(), 'board-wizard-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

function decision(overrides: Partial<SetupDecision> = {}): SetupDecision {
  const settings: BoardSettings = {
    version: 2,
    reviewer: { model: null },
    specReview: { mode: 'auto', maxSpecChars: 1500, largeSpecChars: 6000 },
    runReview: { mode: 'none' },
    branches: { main: null, dev: null },
    git: true,
    sync: { remote: null },
    backlog: { path: 'docs/board/BACKLOG.md', auto: true },
    setupAt: null,
  }
  return {
    settings,
    json: false,
    yes: false,
    stdinIsTTY: true,
    stdoutIsTTY: true,
    ...overrides,
  }
}

function ttyStream(): PassThrough & { isTTY?: boolean } {
  const stream = new PassThrough() as PassThrough & { isTTY?: boolean }
  stream.isTTY = true
  return stream
}

function tracker(output: PassThrough) {
  let text = ''
  output.on('data', (chunk: Buffer) => (text += chunk.toString('utf8')))
  return {
    text: () => text,
    waitFor(needle: string): Promise<void> {
      return new Promise((resolve) => {
        const check = () => {
          if (!text.includes(needle)) return
          output.off('data', check)
          resolve()
        }
        if (text.includes(needle)) {
          resolve()
          return
        }
        output.on('data', check)
      })
    },
  }
}

test('shouldRunSetup: мастер нужен только один раз и только в TTY', () => {
  assert.equal(shouldRunSetup(decision()), true)
  assert.equal(
    shouldRunSetup(decision({ settings: { ...decision().settings, setupAt: '2026-11-19T10:00:00.000Z' } })),
    false,
  )
  assert.equal(shouldRunSetup(decision({ json: true })), false)
  assert.equal(shouldRunSetup(decision({ yes: true })), false)
  assert.equal(shouldRunSetup(decision({ stdinIsTTY: false })), false)
  assert.equal(shouldRunSetup(decision({ stdoutIsTTY: false })), false)
})

test('runSetupWizard: собирает все ответы', async (t) => {
  const root = tempDir(t)
  const settings = ensureSettings(root).settings
  const input = ttyStream()
  const output = ttyStream()
  const seen = tracker(output)

  const done = runSetupWizard(root, settings, { input, output })
  await seen.waitFor('Ревью spec')
  input.write('self\n')
  await seen.waitFor('Порог для max')
  input.write('2000\n')
  await seen.waitFor('Большой spec')
  input.write('4000\n')
  await seen.waitFor('Ревью в конце забега')
  input.write('subagent\n')
  await seen.waitFor('Модель ревьюера')
  input.write('opencode-go/deepseek-v4.1-flash\n')

  const next = await done
  assert.deepEqual(next.specReview, { mode: 'self', maxSpecChars: 2000, largeSpecChars: 4000 })
  assert.deepEqual(next.runReview, { mode: 'subagent' })
  assert.deepEqual(next.reviewer, { model: 'opencode-go/deepseek-v4.1-flash' })
  assert.ok(next.setupAt)
  assert.deepEqual(readSettings(root), next)
})

test('runSetupWizard: пустые ответы оставляют текущие значения', async (t) => {
  const root = tempDir(t)
  const settings = ensureSettings(root).settings
  const input = ttyStream()
  const output = ttyStream()
  const seen = tracker(output)

  const done = runSetupWizard(root, settings, { input, output })
  for (const prompt of ['Ревью spec', 'Порог для max', 'Большой spec', 'Ревью в конце забега', 'Модель ревьюера']) {
    await seen.waitFor(prompt)
    input.write('\n')
  }

  const next = await done
  assert.deepEqual(next.specReview, { mode: 'auto', maxSpecChars: 1500, largeSpecChars: 6000 })
  assert.deepEqual(next.runReview, { mode: 'none' })
  assert.deepEqual(next.reviewer, { model: null })
  assert.ok(next.setupAt)
})

test('runSetupWizard: невалидный режим переспрашивает', async (t) => {
  const root = tempDir(t)
  const settings = ensureSettings(root).settings
  const input = ttyStream()
  const output = ttyStream()
  const seen = tracker(output)

  const done = runSetupWizard(root, settings, { input, output })
  await seen.waitFor('Ревью spec')
  input.write('sometimes\n')
  await seen.waitFor('Допустимо: auto')
  input.write('self\n')
  await seen.waitFor('Порог для max')
  input.write('\n')
  await seen.waitFor('Большой spec')
  input.write('\n')
  await seen.waitFor('Ревью в конце забега')
  input.write('\n')
  await seen.waitFor('Модель ревьюера')
  input.write('\n')

  const next = await done
  assert.equal(next.specReview.mode, 'self')
  assert.match(seen.text(), /Допустимо: auto/)
})

test('runSetupWizard: без TTY ничего не меняет', async (t) => {
  const root = tempDir(t)
  const settings = ensureSettings(root).settings
  const input = ttyStream()
  input.isTTY = false
  input.end('self\n')

  const next = await runSetupWizard(root, settings, { input, output: ttyStream() })
  assert.deepEqual(next, settings)
  assert.equal(readSettings(root).setupAt, null)
})
