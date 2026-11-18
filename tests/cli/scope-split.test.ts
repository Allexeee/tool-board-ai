import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const bin = resolve('bin/toolbox-al.ts')

function run(dir: string, args: string[]) {
  const result = spawnSync(process.execPath, [bin, ...args], { cwd: dir, encoding: 'utf8', windowsHide: true })
  return { code: result.status, out: result.stdout, err: result.stderr }
}

test('task add --scope "a,b" сохраняет два пути', () => {
  const dir = mkdtempSync(join(tmpdir(), 'al-scope-split-'))
  run(dir, ['init'])

  const added = run(dir, ['task', 'add', 'Поправить', '--dod', 'готово', '--skill', 'backend', '--scope', 'src/a.ts,src/b.ts'])
  assert.equal(added.code, 0)

  const shown = run(dir, ['task', 'show', 'T1'])
  assert.match(shown.out, /src\/a\.ts, src\/b\.ts/)
})

test('task edit --scope с запятой тоже разбирается', () => {
  const dir = mkdtempSync(join(tmpdir(), 'al-scope-split-edit-'))
  run(dir, ['init'])
  run(dir, ['task', 'add', 'Поправить', '--dod', 'готово', '--skill', 'backend', '--scope', 'src/**'])

  run(dir, ['task', 'edit', 'T1', '--scope', 'src/a.ts,src/b.ts', '--as', 'orchestrator'])

  const shown = run(dir, ['task', 'show', 'T1'])
  assert.match(shown.out, /src\/a\.ts, src\/b\.ts/)
})

test('--scope exclusive остаётся эксклюзивной областью', () => {
  const dir = mkdtempSync(join(tmpdir(), 'al-scope-exclusive-'))
  run(dir, ['init'])
  run(dir, ['task', 'add', 'Один', '--dod', 'готово', '--skill', 'backend', '--scope', 'exclusive'])

  const shown = run(dir, ['task', 'show', 'T1'])
  assert.match(shown.out, /эксклюзивно/)
})
