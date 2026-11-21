import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { makeBoard } from '../helpers/board.ts'

const bin = resolve('bin/board.ts')

interface Result {
  code: number | null
  out: string
  err: string
}

function run(dir: string, args: string[]): Result {
  const result = spawnSync(process.execPath, [bin, ...args], {
    cwd: dir,
    encoding: 'utf8',
    windowsHide: true,
  })
  return { code: result.status, out: result.stdout ?? '', err: result.stderr ?? '' }
}

function json(dir: string, args: string[]): Record<string, unknown> {
  const result = run(dir, [...args, '--json'])
  assert.equal(result.code, 0, result.err)
  return JSON.parse(result.out) as Record<string, unknown>
}

test('setup: по умолчанию ревью выключено, состояние читается через --show', (t) => {
  const fixture = makeBoard()
  t.after(fixture.close)

  const shown = json(fixture.root, ['setup', '--show'])
  assert.equal(shown.reviewAfterRun, false)
  assert.equal(shown.setupAt, null)
})

test('setup: включает и выключает ревью после забега', (t) => {
  const fixture = makeBoard()
  t.after(fixture.close)

  const on = json(fixture.root, ['setup', '--review-after-run'])
  assert.equal(on.reviewAfterRun, true)
  assert.match(String(on.setupAt), /^\d{4}-\d{2}-\d{2}T/)

  const shown = json(fixture.root, ['setup', '--show'])
  assert.equal(shown.reviewAfterRun, true)

  const off = json(fixture.root, ['setup', '--no-review-after-run'])
  assert.equal(off.reviewAfterRun, false)
})

test('setup: взаимоисключающие флаги — код 3', (t) => {
  const fixture = makeBoard()
  t.after(fixture.close)

  const both = run(fixture.root, ['setup', '--review-after-run', '--no-review-after-run'])
  assert.equal(both.code, 3)
  assert.match(both.err, /только один флаг/)

  const showAndToggle = run(fixture.root, ['setup', '--show', '--review-after-run'])
  assert.equal(showAndToggle.code, 3)
  assert.match(showAndToggle.err, /--show/)
})

test('setup без TTY не спрашивает и подсказывает терминал', (t) => {
  const fixture = makeBoard()
  t.after(fixture.close)

  const result = run(fixture.root, ['setup'])
  assert.equal(result.code, 0, result.err)
  assert.match(result.out, /Запустите в терминале: board setup/)
})

test('init --json создаёт настройки, setup.md и просит запустить мастер', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'board-init-settings-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))

  const result = run(root, ['init', '--json'])
  assert.equal(result.code, 0, result.err)

  const data = JSON.parse(result.out) as {
    created: string[]
    updated: string[]
    setupRequired: boolean
    settings: { reviewAfterRun: boolean; setupAt: string | null }
  }
  assert.ok(data.created.includes('.board/settings.json'))
  assert.deepEqual(data.updated, [])
  assert.equal(data.setupRequired, true)
  assert.equal(data.settings.reviewAfterRun, false)
  assert.equal(data.settings.setupAt, null)
  assert.ok(existsSync(join(root, '.opencode', 'command', 'setup.md')))

  json(root, ['setup', '--review-after-run'])
  const again = JSON.parse(run(root, ['init', '--json']).out) as { setupRequired: boolean }
  assert.equal(again.setupRequired, false)
})

test('init --refresh обновляет старый плагин и скилл', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'board-init-refresh-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))

  assert.equal(run(root, ['init', '--json']).code, 0)
  const plugin = join(root, '.opencode', 'plugins', 'board', 'index.ts')
  const skill = join(root, '.opencode', 'skills', 'board', 'SKILL.md')
  writeFileSync(plugin, '// старый плагин\n', 'utf8')
  writeFileSync(skill, '# старый скилл\n', 'utf8')

  const result = run(root, ['init', '--refresh', '--json'])
  assert.equal(result.code, 0, result.err)
  const data = JSON.parse(result.out) as { updated: string[] }

  assert.ok(data.updated.some((path) => path.includes('plugins/board/index.ts')))
  assert.ok(data.updated.some((path) => path.includes('skills/board/SKILL.md')))
  assert.match(readFileSync(plugin, 'utf8'), /board_setup/)
  assert.match(readFileSync(skill, 'utf8'), /## Настройки/)
})
