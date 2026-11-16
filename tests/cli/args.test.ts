import test from 'node:test'
import assert from 'node:assert/strict'
import { parseArgs } from '../../src/cli/args.ts'

test('разбирает команду, подкоманду, флаги и позиционные', () => {
  const r = parseArgs(['task', 'add', 'F1.S1', '--size', 'S', '--json', '--dod', 'a'])
  assert.equal(r.command, 'task')
  assert.equal(r.sub, 'add')
  assert.deepEqual(r.positionals, ['F1.S1'])
  assert.equal(r.flags.size, 'S')
  assert.equal(r.flags.json, true)
  assert.equal(r.flags.dod, 'a')
})

test('неизвестный флаг отвергается', () => {
  assert.throws(() => parseArgs(['now', '--nope']), /неизвестный флаг/)
})

test('--help без команды не требует команды', () => {
  assert.equal(parseArgs(['--help']).command, 'help')
})
