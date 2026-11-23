import test from 'node:test'
import assert from 'node:assert/strict'
import { boolFlag, numberFlag, parseArgs, stringFlag, stringsFlag } from '../../src/cli/args.ts'

test('разбирает команду, подкоманду, флаги и позиционные', () => {
  const args = parseArgs(['card', 'add', '--group', 'UI', '--title', 'Форма входа', '--skill', 'dev'])
  assert.equal(args.command, 'card')
  assert.equal(args.sub, 'add')
  assert.deepEqual(args.positionals, [])
  assert.equal(stringFlag(args, 'group'), 'UI')
  assert.equal(stringFlag(args, 'title'), 'Форма входа')
  assert.equal(stringFlag(args, 'skill'), 'dev')
})

test('--json известен всем командам и не съедает команду', () => {
  const args = parseArgs(['--json', 'init'])
  assert.equal(args.command, 'init')
  assert.equal(boolFlag(args, 'json'), true)
})

test('повторный --scope собирается в массив', () => {
  const args = parseArgs([
    'card', 'edit', 'UI-1', '--scope', 'src/**', '--scope', 'tests/**', '--importance', '3',
  ])
  assert.deepEqual(stringsFlag(args, 'scope'), ['src/**', 'tests/**'])
  assert.equal(numberFlag(args, 'importance'), 3)
})

test('флаг со значением без значения — ошибка ввода', () => {
  assert.throws(() => parseArgs(['card', 'list', '--limit']), /--limit нужно значение/)
  assert.throws(() => parseArgs(['setup', '--max-spec', '--json']), /--max-spec нужно значение/)
})

test('подкоманды новых команд разбираются', () => {
  for (const command of ['card', 'executor', 'queue', 'run', 'decision', 'term', 'command', 'review']) {
    const args = parseArgs([command, 'list'])
    assert.equal(args.command, command)
    assert.equal(args.sub, 'list', `subcommand of ${command}`)
  }

  const now = parseArgs(['now', '3', '--group', 'UI'])
  assert.equal(now.command, 'now')
  assert.equal(now.sub, null)
  assert.deepEqual(now.positionals, ['3'])
})

test('неизвестный флаг отвергается с кодом 3', () => {
  assert.throws(
    () => parseArgs(['now', '--nope']),
    (error: { code?: number; message?: string }) => error.code === 3 && /неизвестный флаг/.test(error.message ?? ''),
  )
})

test('булевы флаги не требуют значения', () => {
  const args = parseArgs(['card', 'edit', 'UI-1', '--no-review', '--needs-merge'])
  assert.equal(boolFlag(args, 'no-review'), true)
  assert.equal(boolFlag(args, 'needs-merge'), true)
  assert.equal(boolFlag(args, 'review'), false)
})

test('numberFlag отвергает мусор', () => {
  const args = parseArgs(['card', 'edit', 'UI-1', '--urgency', 'много'])
  assert.throws(() => numberFlag(args, 'urgency'), /urgency/)
})

test('--help и --version не требуют команды', () => {
  assert.equal(parseArgs(['--help']).command, 'help')
  assert.equal(parseArgs(['--version']).command, 'version')
})
