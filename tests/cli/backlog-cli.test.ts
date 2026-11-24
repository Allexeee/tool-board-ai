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
    env: { ...process.env, BOARD_ALLOW_GLOBAL: '1' },
    windowsHide: true,
  })
  return { code: result.status, out: result.stdout, err: result.stderr }
}

function project(t: { after: (fn: () => void) => void }): string {
  const dir = mkdtempSync(join(tmpdir(), 'board-backlog-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  assert.equal(run(dir, ['init']).code, 0)
  return dir
}

test('board backlog собирает md по пути из настроек', (t) => {
  const dir = project(t)
  assert.equal(
    run(dir, ['card', 'add', '--group', 'SITE', '--title', 'Страница', '--skill', 'dev']).code,
    0,
  )

  const built = run(dir, ['backlog', '--json'])
  assert.equal(built.code, 0, built.err)
  const path = (JSON.parse(built.out) as { path: string }).path
  assert.equal(path, join(dir, 'docs/board/BACKLOG.md'))
  assert.ok(existsSync(path))

  const md = readFileSync(path, 'utf8')
  assert.match(md, /Страница/)
  assert.match(md, /новый запрос/)
  assert.match(md, /Не редактируйте вручную/)
})

test('board backlog --out пишет по указанному пути', (t) => {
  const dir = project(t)
  run(dir, ['card', 'add', '--group', 'SITE', '--title', 'Одна', '--skill', 'dev'])

  const built = run(dir, ['backlog', '--out', 'custom/BOARD.md', '--json'])
  assert.equal(built.code, 0, built.err)
  assert.ok(existsSync(join(dir, 'custom/BOARD.md')))
})
