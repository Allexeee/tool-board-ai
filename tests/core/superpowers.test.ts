import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  CONFLICTING_SKILLS,
  conflictingSkillsDisabled,
  superpowersConfigured,
  SUPERPOWERS_ADVICE,
  writeSkillPermissions,
} from '../../src/core/superpowers.ts'

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

test('writeSkillPermissions: запреты, чужие ключи и идемпотентность', (t) => {
  const root = tempDir(t)
  const home = tempDir(t)
  writeConfig(root, ['superpowers'])

  const first = writeSkillPermissions(root, home)
  assert.equal(first.changed, true)
  assert.equal(first.created, false)

  const parsed = JSON.parse(
    readFileSync(join(root, '.opencode', 'opencode.json'), 'utf8'),
  ) as { plugins: string[]; permissions: Array<Record<string, string>> }
  assert.deepEqual(parsed.plugins, ['superpowers'])
  assert.equal(parsed.permissions.length, CONFLICTING_SKILLS.length)
  for (const skill of CONFLICTING_SKILLS) {
    assert.ok(
      parsed.permissions.some(
        (rule) =>
          rule.action === 'skill' && rule.resource === skill && rule.effect === 'deny',
      ),
      skill,
    )
  }
  assert.equal(conflictingSkillsDisabled(root, home), true)

  assert.equal(writeSkillPermissions(root, home).changed, false)
  const again = JSON.parse(
    readFileSync(join(root, '.opencode', 'opencode.json'), 'utf8'),
  ) as { permissions: unknown[] }
  assert.equal(again.permissions.length, CONFLICTING_SKILLS.length)
})

test('writeSkillPermissions: без superpowers файл не создаётся', (t) => {
  const root = tempDir(t)
  const home = tempDir(t)
  const result = writeSkillPermissions(root, home)
  assert.equal(result.changed, false)
  assert.equal(existsSync(join(root, '.opencode', 'opencode.json')), false)
})

test('superpowers в корневом opencode.json: права пишутся туда', (t) => {
  const root = tempDir(t)
  const home = tempDir(t)
  writeFileSync(
    join(root, 'opencode.json'),
    JSON.stringify({ plugins: ['superpowers'] }),
    'utf8',
  )

  assert.equal(superpowersConfigured(root, home), true)
  const result = writeSkillPermissions(root, home)
  assert.equal(result.changed, true)
  assert.equal(result.path, join(root, 'opencode.json'))

  const parsed = JSON.parse(readFileSync(join(root, 'opencode.json'), 'utf8')) as {
    plugins: string[]
    permissions: Array<Record<string, string>>
  }
  assert.deepEqual(parsed.plugins, ['superpowers'])
  assert.equal(parsed.permissions.length, CONFLICTING_SKILLS.length)
  assert.equal(existsSync(join(root, '.opencode', 'opencode.json')), false)
  assert.equal(conflictingSkillsDisabled(root, home), true)
})

test('superpowers в opencode.jsonc с комментариями', (t) => {
  const root = tempDir(t)
  const home = tempDir(t)
  writeFileSync(
    join(root, 'opencode.jsonc'),
    '{\n  // плагины проекта\n  "plugins": ["superpowers"],\n}\n',
    'utf8',
  )

  assert.equal(superpowersConfigured(root, home), true)
  assert.equal(writeSkillPermissions(root, home).changed, true)

  const parsed = JSON.parse(readFileSync(join(root, 'opencode.jsonc'), 'utf8')) as {
    permissions: Array<Record<string, string>>
  }
  assert.ok(
    parsed.permissions.some(
      (rule) => rule.action === 'skill' && rule.resource === 'writing-plans' && rule.effect === 'deny',
    ),
  )
  assert.equal(conflictingSkillsDisabled(root, home), true)
})

test('writeSkillPermissions: битый проектный json не перезаписывается', (t) => {
  const root = tempDir(t)
  const home = tempDir(t)
  mkdirSync(join(home, '.config', 'opencode'), { recursive: true })
  writeFileSync(
    join(home, '.config', 'opencode', 'opencode.json'),
    JSON.stringify({ plugins: ['superpowers'] }),
    'utf8',
  )
  mkdirSync(join(root, '.opencode'), { recursive: true })
  const path = join(root, '.opencode', 'opencode.json')
  writeFileSync(path, '{ не json', 'utf8')

  const result = writeSkillPermissions(root, home)
  assert.equal(result.changed, false)
  assert.match(result.warning ?? '', /не разобран/)
  assert.equal(readFileSync(path, 'utf8'), '{ не json')
  assert.equal(conflictingSkillsDisabled(root, home), false)
})
