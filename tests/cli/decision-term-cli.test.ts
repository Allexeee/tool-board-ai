import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const bin = resolve('bin/board.ts')

function run(dir: string, args: string[]) {
  const result = spawnSync(process.execPath, [bin, ...args], {
    cwd: dir,
    encoding: 'utf8',
    windowsHide: true,
  })
  return { code: result.status, out: result.stdout, err: result.stderr }
}

function project(t: { after: (fn: () => void) => void }): string {
  const dir = mkdtempSync(join(tmpdir(), 'board-dt-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const init = run(dir, ['init'])
  assert.equal(init.code, 0, init.err)
  return dir
}

function json(dir: string, args: string[]) {
  const result = run(dir, [...args, '--json'])
  assert.equal(result.code, 0, result.err)
  return JSON.parse(result.out)
}

test('decision add/list/supersede пересобирают decisions.md', (t) => {
  const dir = project(t)

  const d1 = json(dir, ['decision', 'add', 'UI-1', 'VK API', '--as', 'developer'])
  assert.equal(d1.id, 'D1')
  assert.equal(d1.cardId, 'UI-1')
  assert.equal(d1.status, 'actual')

  const d2 = json(dir, ['decision', 'add', 'UI-1', 'VK закрыт', '--as', 'owner'])
  assert.equal(d2.id, 'D2')

  json(dir, ['decision', 'supersede', 'D1', '--by', 'D2', '--reason', 'нет доступа'])

  const md = readFileSync(join(dir, 'docs', 'board', 'decisions.md'), 'utf8')
  assert.match(md, /VK закрыт/)
  assert.match(md, /~~/)
  assert.ok(md.indexOf('VK закрыт') < md.indexOf('VK API'))

  const list = json(dir, ['decision', 'list'])
  assert.equal(list.length, 2)
  assert.equal(list.find((d: { id: string }) => d.id === 'D1').status, 'cancelled')
})

test('term add/list/show и command add/list через CLI', (t) => {
  const dir = project(t)

  const added = json(dir, ['term', 'add', 'забег', 'сессия работы агента', '--as', 'developer'])
  assert.equal(added.added, true)
  assert.equal(added.duplicate, false)

  const dup = json(dir, ['term', 'add', 'забег', 'другое', '--as', 'marketer'])
  assert.equal(dup.duplicate, true)

  const terms = json(dir, ['term', 'list'])
  assert.equal(terms.length, 2)

  const shown = json(dir, ['term', 'show', 'забег'])
  assert.equal(shown.definition, 'сессия работы агента')

  const forbidden = run(dir, ['command', 'add', 'RUN', 'начать забег', '--as', 'developer'])
  assert.equal(forbidden.code, 3)
  assert.match(forbidden.err, /owner/)

  const cmd = json(dir, ['command', 'add', 'RUN', 'начать забег', '--as', 'owner'])
  assert.equal(cmd.added, true)

  const commands = json(dir, ['command', 'list'])
  assert.equal(commands[0].command, 'RUN')

  assert.ok(existsSync(join(dir, 'docs', 'board', 'terminology.md')))
})
