import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { createCard } from '../../src/core/cards.ts'
import { makeBoard } from '../helpers/board.ts'
import { writeOpenCodeFiles } from '../../src/core/opencode.ts'

/** Вырезает функцию из сгенерированного плагина: он не импортируется в тестах. */
function extractFunction(source: string, name: string): string {
  const start = source.indexOf(`function ${name}(`)
  assert.ok(start >= 0, `нет функции ${name}`)
  const rest = source.slice(start)
  const end = rest.search(/\n}\r?\n/)
  assert.ok(end > 0, `нет конца функции ${name}`)
  return rest.slice(0, end + 2)
}

function extractAsync(source: string, name: string): string {
  const start = source.indexOf(`async function ${name}(`)
  assert.ok(start >= 0, `нет функции ${name}`)
  const rest = source.slice(start)
  const end = rest.search(/\n}\r?\n/)
  assert.ok(end > 0, `нет конца функции ${name}`)
  return rest.slice(0, end + 2)
}

test('плагин: сквозной вызов CLI через call()', async (t) => {
  const board = makeBoard()
  t.after(board.close)

  writeOpenCodeFiles(board.root)
  const source = readFileSync(join(board.root, '.opencode', 'plugins', 'board', 'index.ts'), 'utf8')

  const factory = new Function(
    'execFile',
    'promisify',
    'existsSync',
    'join',
    'basename',
    'dirname',
    'nodeBin',
    'process',
    [
      extractFunction(source, 'projectRoot'),
      extractFunction(source, 'resolveCli'),
      'const run = promisify(execFile)',
      extractAsync(source, 'call'),
      'return call',
    ].join('\n'),
  )
  const call = factory(
    execFile,
    promisify,
    existsSync,
    join,
    basename,
    dirname,
    process.execPath,
    process,
  ) as (
    ctx: unknown,
    args: string[],
    context: unknown,
  ) => Promise<{ content: string; isError?: boolean }>

  process.env.BOARD_CLI = resolve('bin/board.ts')
  const card = createCard(board.db, {
    group: 'TST',
    title: 'сквозной',
    skill: 'dev',
    author: 'owner',
  })

  const result = await call(
    { location: { directory: board.root }, session: { get: async () => ({ model: null }) } },
    ['card', 'list'],
    { sessionID: 's' },
  )

  assert.equal(result.isError, undefined)
  const list = JSON.parse(result.content) as Array<{ id: string }>
  assert.ok(list.some((item) => item.id === card.id))
})
