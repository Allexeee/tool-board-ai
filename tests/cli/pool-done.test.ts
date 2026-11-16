import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const bin = resolve('bin/toolbox-al.ts')
const flags = ['--dod', 'текст исправлен', '--size', 'XS', '--skill', 'backend', '--class', 'quick', '--scope', 'docs/**']

function run(dir: string, args: string[]) {
  const result = execFileSync(process.execPath, [bin, ...args], { cwd: dir, encoding: 'utf8' })
  return result
}

function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'al-pool-done-'))
  execFileSync('git', ['init', '-q'], { cwd: dir })
  execFileSync('git', ['config', 'user.email', 't@e.x'], { cwd: dir })
  execFileSync('git', ['config', 'user.name', 'T'], { cwd: dir })
  writeFileSync(join(dir, 'README.md'), 'x')
  execFileSync('git', ['add', '.'], { cwd: dir })
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: dir })

  run(dir, ['init'])
  run(dir, ['executor', 'add', 'w1', '--skills', 'backend'])
  execFileSync('git', ['add', '.'], { cwd: dir })
  execFileSync('git', ['commit', '-q', '-m', 'setup'], { cwd: dir })
  return dir
}

test('done по задаче пула делает коммит в корне проекта', () => {
  const dir = repo()
  run(dir, ['task', 'add', 'Поправить текст', ...flags])
  run(dir, ['take', 'T1', '--as', 'w1'])

  mkdirSync(join(dir, 'docs'), { recursive: true })
  writeFileSync(join(dir, 'docs', 'guide.md'), 'исправлено')

  const out = run(dir, ['done', 'T1', '--as', 'w1', '--summary', 'текст поправлен'])
  assert.match(out, /на ревью|закрыта/)

  const log = execFileSync('git', ['log', '-1', '--pretty=%s'], { cwd: dir, encoding: 'utf8' })
  assert.match(log, /T1: Поправить текст/)
})

test('done отказывает, если каталог фичи пропал', () => {
  const dir = repo()
  run(dir, ['request', 'add', 'Фича'])
  run(dir, ['feature', 'add', 'Фича', '--request', 'R1'])
  run(dir, ['stage', 'add', 'F1', 'S1', '--goal', 'g', '--appetite', '1 день'])
  run(dir, ['stage', 'activate', 'F1'])
  run(dir, ['task', 'add', 'F1.S1', 'Сделать', ...flags])
  run(dir, ['take', 'F1.S1-1', '--as', 'w1'])

  assert.throws(
    () => run(dir, ['done', 'F1.S1-1', '--as', 'w1', '--summary', 'готово']),
    /рабочего каталога/,
  )
})
