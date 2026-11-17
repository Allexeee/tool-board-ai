import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const bin = resolve('bin/toolbox-al.ts')

function run(dir: string, args: string[]) {
  const result = spawnSync(process.execPath, [bin, ...args], { cwd: dir, encoding: 'utf8' })
  return { code: result.status, out: result.stdout, err: result.stderr }
}

const goodStep = {
  title: 'Подключить SDK',
  skill: 'backend',
  size: 'S',
  dod: ['клиент создаётся'],
  scope: ['src/**'],
}

function project(steps: unknown[] = [goodStep]) {
  const dir = mkdtempSync(join(tmpdir(), 'al-plan-'))
  run(dir, ['init'])
  run(dir, ['request', 'add', 'Оплата'])
  const file = join(dir, 'plan.json')
  writeFileSync(
    file,
    JSON.stringify({
      title: 'Оплата',
      assumptions: [],
      stages: [{ name: 'Каркас', goal: 'можно платить', appetite: '2 дня', steps }],
    }),
    'utf8',
  )
  run(dir, ['plan', 'new', 'R1', file])
  return dir
}

test('plan show печатает DoD, область и приёмку', () => {
  const dir = project()
  const shown = run(dir, ['plan', 'show', 'R1'])

  assert.equal(shown.code, 0, shown.err)
  assert.match(shown.out, /DoD: клиент создаётся/)
  assert.match(shown.out, /область: src\/\*\*/)
  assert.match(shown.out, /приёмка/)
})

test('план адресуется по P-id', () => {
  const dir = project()
  const shown = run(dir, ['plan', 'show', 'P1'])

  assert.equal(shown.code, 0, shown.err)
  assert.match(shown.out, /Оплата/)
})

test('approve отказывает на неполном плане', () => {
  const dir = project([{ ...goodStep, dod: [] }])
  const approved = run(dir, ['plan', 'approve', 'R1'])

  assert.equal(approved.code, 3)
  assert.match(approved.err, /нет DoD/)
})
