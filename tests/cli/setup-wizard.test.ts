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
    version: 1,
    reviewAfterRun: false,
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

test('runSetupWizard: ответ да включает ревью и отмечает setupAt', async (t) => {
  const root = tempDir(t)
  const settings = ensureSettings(root).settings

  const input = ttyStream()
  input.end('да\n')
  const next = await runSetupWizard(root, settings, { input, output: ttyStream() })

  assert.equal(next.reviewAfterRun, true)
  assert.ok(next.setupAt)
  assert.equal(readSettings(root).reviewAfterRun, true)
})

test('runSetupWizard: пустой ответ оставляет текущее значение', async (t) => {
  const root = tempDir(t)
  const settings = ensureSettings(root).settings

  const input = ttyStream()
  input.end('\n')
  const next = await runSetupWizard(root, settings, { input, output: ttyStream() })

  assert.equal(next.reviewAfterRun, false)
  assert.ok(next.setupAt)
})

test('runSetupWizard: непонятный ответ переспрашивает и не завершает мастер', async (t) => {
  const root = tempDir(t)
  const settings = ensureSettings(root).settings

  const input = ttyStream()
  const output = ttyStream()
  let text = ''
  output.on('data', (chunk: Buffer) => (text += chunk.toString('utf8')))

  const reasked = new Promise<void>((resolve) => {
    const onData = (chunk: Buffer) => {
      if (!chunk.toString('utf8').includes('Ответьте y/yes')) return
      output.off('data', onData)
      resolve()
    }
    output.on('data', onData)
  })

  const done = runSetupWizard(root, settings, { input, output })
  input.write('может быть\n')
  await reasked
  input.end('n\n')
  const next = await done

  assert.equal(next.reviewAfterRun, false)
  assert.match(text, /Ответьте y\/yes/)
  assert.ok(next.setupAt)
})

test('runSetupWizard: без TTY ничего не пишет и не запускает мастер', async (t) => {
  const root = tempDir(t)
  const settings = ensureSettings(root).settings

  const input = ttyStream()
  input.isTTY = false
  input.end('y\n')
  const next = await runSetupWizard(root, settings, { input, output: ttyStream() })

  assert.deepEqual(next, settings)
  assert.equal(readSettings(root).setupAt, null)
})
