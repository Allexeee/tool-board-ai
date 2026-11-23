import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { superpowersConfigured, SUPERPOWERS_ADVICE } from '../../src/core/superpowers.ts'

function tempDir(t: { after: (fn: () => void) => void }): string {
  const dir = mkdtempSync(join(tmpdir(), 'board-superpowers-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

function writeConfig(dir: string, plugins: unknown): void {
  mkdirSync(join(dir, '.opencode'), { recursive: true })
  writeFileSync(join(dir, '.opencode', 'opencode.json'), JSON.stringify({ plugins }), 'utf8')
}

test('superpowersConfigured: проектный конфиг с плагином', (t) => {
  const root = tempDir(t)
  const home = tempDir(t)
  writeConfig(root, ['C:\\Users\\x\\node_modules\\superpowers'])
  assert.equal(superpowersConfigured(root, home), true)
})

test('superpowersConfigured: глобальный конфиг с плагином', (t) => {
  const root = tempDir(t)
  const home = tempDir(t)
  mkdirSync(join(home, '.config', 'opencode'), { recursive: true })
  writeFileSync(
    join(home, '.config', 'opencode', 'opencode.json'),
    JSON.stringify({ plugins: ['superpowers'] }),
    'utf8',
  )
  assert.equal(superpowersConfigured(root, home), true)
})

test('superpowersConfigured: без конфига и с битым конфигом — false', (t) => {
  const root = tempDir(t)
  const home = tempDir(t)
  assert.equal(superpowersConfigured(root, home), false)

  writeConfig(root, ['other-plugin'])
  assert.equal(superpowersConfigured(root, home), false)

  mkdirSync(join(root, '.opencode'), { recursive: true })
  writeFileSync(join(root, '.opencode', 'opencode.json'), '{ не json', 'utf8')
  assert.equal(superpowersConfigured(root, home), false)
})

test('SUPERPOWERS_ADVICE объясняет, зачем подключать brainstorming', () => {
  assert.match(SUPERPOWERS_ADVICE, /superpowers/)
  assert.match(SUPERPOWERS_ADVICE, /brainstorming/)
  assert.match(SUPERPOWERS_ADVICE, /точность/)
  assert.match(SUPERPOWERS_ADVICE, /opencode\.json/)
})
