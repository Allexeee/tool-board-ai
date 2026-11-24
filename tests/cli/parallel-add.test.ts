import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { openDb } from '../../src/core/db.ts'
import { listCards } from '../../src/core/cards.ts'

const run = promisify(execFile)
const bin = resolve('bin/board.ts')

async function cli(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await run(process.execPath, [bin, ...args], {
    cwd,
    env: { ...process.env, BOARD_ALLOW_GLOBAL: '1' },
    windowsHide: true,
  })
  return stdout
}

test('шесть параллельных card add создают шесть карточек', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'board-parallel-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))

  await cli(dir, ['init'])
  await cli(dir, ['card', 'add', '--group', 'PAR', '--title', 'база', '--skill', 'dev'])

  const results = await Promise.allSettled(
    [1, 2, 3, 4, 5, 6].map((n) =>
      cli(dir, ['card', 'add', '--group', 'PAR', '--title', `t${n}`, '--skill', 'dev', '--json']),
    ),
  )
  const failed = results.filter((item) => item.status === 'rejected')
  assert.equal(failed.length, 0, JSON.stringify(failed.map((item) => String(item))))

  const db = openDb(join(dir, '.board', 'board.db'))
  try {
    const cards = listCards(db).filter((card) => card.group === 'PAR')
    assert.equal(cards.length, 7)
  } finally {
    db.close()
  }
})
