import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { openDb } from '../../src/core/db.ts'
import { listEvents } from '../../src/core/events.ts'

const bin = resolve('bin/toolbox-al.ts')

function run(dir: string, args: string[]) {
  const result = execFileSync(process.execPath, [bin, ...args], {
    cwd: dir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  return result
}

function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'al-done-out-'))
  execFileSync('git', ['init', '-q'], { cwd: dir })
  execFileSync('git', ['config', 'user.email', 't@e.x'], { cwd: dir })
  execFileSync('git', ['config', 'user.name', 'T'], { cwd: dir })
  writeFileSync(join(dir, 'README.md'), 'x')
  execFileSync('git', ['add', '.'], { cwd: dir })
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: dir })
  execFileSync('git', ['branch', 'dev'], { cwd: dir })
  execFileSync('git', ['checkout', '-q', 'dev'], { cwd: dir })

  run(dir, ['init'])
  execFileSync('git', ['add', '.'], { cwd: dir })
  execFileSync('git', ['commit', '-q', '-m', 'setup'], {
    cwd: dir,
    env: { ...process.env, AL_ALLOW: '1' },
  })
  run(dir, ['executor', 'add', 'w1', '--skills', 'backend'])
  run(dir, ['task', 'add', 'Правка', '--dod', 'a', '--skill', 'backend', '--scope', 'src/**'])
  run(dir, ['task', 'list'])
  run(dir, ['take', 'T1', '--as', 'w1'])
  return dir
}

test('done отказывается закрывать задачу с правками вне области', () => {
  const dir = repo()
  mkdirSync(join(dir, 'src'), { recursive: true })
  mkdirSync(join(dir, 'docs'), { recursive: true })
  writeFileSync(join(dir, 'src/a.ts'), 'a')
  writeFileSync(join(dir, 'docs/b.md'), 'b')

  assert.throws(
    () => run(dir, ['done', 'T1', '--as', 'w1', '--summary', 'готово']),
    /вне области/,
  )

  const db = openDb(join(dir, '.toolbox-al/tracker.db'))
  const misses = listEvents(db, { subject: 'T1' }).filter((event) => event.type === 'task.outside_scope')
  assert.equal(misses.length, 0, 'отказ не должен записывать промах')
})

test('с --force-outside чужой файл попадает в коммит', () => {
  const dir = repo()
  mkdirSync(join(dir, 'src'), { recursive: true })
  mkdirSync(join(dir, 'docs'), { recursive: true })
  writeFileSync(join(dir, 'src/a.ts'), 'a')
  writeFileSync(join(dir, 'docs/b.md'), 'b')

  const out = run(dir, ['done', 'T1', '--as', 'w1', '--summary', 'готово', '--force-outside'])
  assert.match(out, /закрыт/)

  const committed = execFileSync('git', ['show', '--name-only', '--pretty=format:', 'HEAD'], {
    cwd: dir,
    encoding: 'utf8',
  })
  assert.match(committed, /src\/a\.ts/)
  assert.match(committed, /docs\/b\.md/, 'файл вне области не должен теряться')

  const status = execFileSync('git', ['status', '--porcelain'], { cwd: dir, encoding: 'utf8' })
  assert.equal(status.trim(), '')
})

test('с --force-outside промах области пишется в журнал', () => {
  const dir = repo()
  mkdirSync(join(dir, 'src'), { recursive: true })
  mkdirSync(join(dir, 'docs'), { recursive: true })
  writeFileSync(join(dir, 'src/a.ts'), 'a')
  writeFileSync(join(dir, 'docs/b.md'), 'b')

  run(dir, ['done', 'T1', '--as', 'w1', '--summary', 'готово', '--force-outside'])

  const db = openDb(join(dir, '.toolbox-al/tracker.db'))
  const misses = listEvents(db, { subject: 'T1' }).filter((event) => event.type === 'task.outside_scope')
  assert.equal(misses.length, 1)
  assert.deepEqual(JSON.parse(misses[0].after ?? '{}'), { files: ['docs/b.md'] })
  assert.equal(misses[0].actor, 'w1')
})
