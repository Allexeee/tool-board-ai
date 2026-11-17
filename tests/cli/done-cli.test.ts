import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

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
})

test('с --force-outside задача закрывается, а чужой файл остаётся', () => {
  const dir = repo()
  mkdirSync(join(dir, 'src'), { recursive: true })
  mkdirSync(join(dir, 'docs'), { recursive: true })
  writeFileSync(join(dir, 'src/a.ts'), 'a')
  writeFileSync(join(dir, 'docs/b.md'), 'b')

  const out = run(dir, ['done', 'T1', '--as', 'w1', '--summary', 'готово', '--force-outside'])
  assert.match(out, /закрыт/)

  const status = execFileSync('git', ['status', '--porcelain'], { cwd: dir, encoding: 'utf8' })
  assert.match(status, /docs\//)
})
