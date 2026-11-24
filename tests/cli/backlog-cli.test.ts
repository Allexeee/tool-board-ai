import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const bin = resolve('bin/board.ts')

function run(dir: string, args: string[], extraEnv: Record<string, string> = {}) {
  const result = spawnSync(process.execPath, [bin, ...args], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, BOARD_ALLOW_GLOBAL: '1', ...extraEnv },
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

test('board backlog --html пишет HTML рядом с md', (t) => {
  const dir = project(t)
  run(dir, ['card', 'add', '--group', 'SITE', '--title', 'Одна', '--skill', 'dev'])

  const built = run(dir, ['backlog', '--html', '--json'])
  assert.equal(built.code, 0, built.err)
  const path = (JSON.parse(built.out) as { path: string }).path
  assert.equal(path, join(dir, 'docs/board/BACKLOG.html'))
  const html = readFileSync(path, 'utf8')
  assert.match(html, /Одна/)
  assert.match(html, /авто 5 с/)
})

test('setup --backlog-refresh меняет интервал, --show печатает', (t) => {
  const dir = project(t)
  const updated = run(dir, ['setup', '--backlog-refresh', '10', '--json'])
  assert.equal(updated.code, 0, updated.err)
  assert.equal((JSON.parse(updated.out) as { backlog: { refreshSeconds: number } }).backlog.refreshSeconds, 10)

  const shown = run(dir, ['setup', '--show'])
  assert.match(shown.out, /обновление 10 с/)

  assert.equal(run(dir, ['setup', '--backlog-refresh', '3601']).code, 3)
})

test('card add пересобирает бэклог по флагу изменений', (t) => {
  const dir = project(t)
  const added = run(dir, ['card', 'add', '--group', 'SITE', '--title', 'Авто', '--skill', 'dev'])
  assert.equal(added.code, 0, added.err)

  assert.ok(existsSync(join(dir, 'docs/board/BACKLOG.md')))
  assert.ok(existsSync(join(dir, 'docs/board/BACKLOG.html')))
  assert.ok(existsSync(join(dir, '.board/backlog.state')))
  assert.match(readFileSync(join(dir, 'docs/board/BACKLOG.html'), 'utf8'), /Авто/)
})

test('board backlog --open собирает html и отдаёт file-url', (t) => {
  const dir = project(t)
  run(dir, ['card', 'add', '--group', 'SITE', '--title', 'Открыть', '--skill', 'dev'])

  const opened = run(dir, ['backlog', '--open', '--json'], { BOARD_OPEN: 'echo' })
  assert.equal(opened.code, 0, opened.err)
  const result = JSON.parse(opened.out) as { path: string; url: string; opened: boolean }
  assert.equal(result.opened, true)
  assert.match(result.url, /^file:\/\//)
  assert.ok(result.url.endsWith('BACKLOG.html'))
  assert.ok(existsSync(result.path))
  assert.match(readFileSync(result.path, 'utf8'), /Открыть/)

  const human = run(dir, ['backlog', '--open'], { BOARD_OPEN: 'echo' })
  assert.equal(human.code, 0, human.err)
  assert.match(human.out, /бэклог открыт: file:\/\//)
})
