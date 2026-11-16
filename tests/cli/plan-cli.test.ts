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

const plan = {
  title: 'Оплата',
  assumptions: [],
  stages: [
    {
      name: 'Каркас',
      goal: 'можно заплатить',
      appetite: '2 дня',
      steps: [
        {
          title: 'Подключить SDK',
          skill: 'backend',
          size: 'S',
          dod: ['клиент создаётся'],
          scope: ['src/**'],
        },
      ],
    },
  ],
}

test('plan new читает файл с BOM', () => {
  const dir = mkdtempSync(join(tmpdir(), 'al-plan-bom-'))
  run(dir, ['init'])
  run(dir, ['request', 'add', 'Оплата'])

  const file = join(dir, 'plan.json')
  writeFileSync(file, '\uFEFF' + JSON.stringify(plan), 'utf8')

  const created = run(dir, ['plan', 'new', 'R1', file])
  assert.equal(created.code, 0, created.err)
  assert.match(created.out, /P\d+/)
})

test('plan new без BOM работает как раньше', () => {
  const dir = mkdtempSync(join(tmpdir(), 'al-plan-nobom-'))
  run(dir, ['init'])
  run(dir, ['request', 'add', 'Оплата'])

  const file = join(dir, 'plan.json')
  writeFileSync(file, JSON.stringify(plan), 'utf8')

  const created = run(dir, ['plan', 'new', 'R1', file])
  assert.equal(created.code, 0, created.err)
})

test('битый JSON объясняет ошибку без стектрейса', () => {
  const dir = mkdtempSync(join(tmpdir(), 'al-plan-bad-'))
  run(dir, ['init'])
  run(dir, ['request', 'add', 'Оплата'])

  const file = join(dir, 'plan.json')
  writeFileSync(file, '{ "title": "Оплата", ', 'utf8')

  const created = run(dir, ['plan', 'new', 'R1', file])
  assert.equal(created.code, 3)
  assert.match(created.err, /не разобрать JSON плана/)
  assert.doesNotMatch(created.err, /at JSON\.parse|at file:/)
})
