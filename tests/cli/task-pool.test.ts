import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { openDb } from '../../src/core/db.ts'
import { parseArgs } from '../../src/cli/args.ts'

const bin = resolve('bin/toolbox-al.ts')
const tmp = () => mkdtempSync(join(tmpdir(), 'al-pool-cli-'))

function run(dir: string, args: string[]) {
  const result = spawnSync(process.execPath, [bin, ...args], { cwd: dir, encoding: 'utf8' })
  return { code: result.status, out: result.stdout, err: result.stderr }
}

const flags = ['--dod', 'опечатки нет', '--size', 'XS', '--skill', 'backend', '--class', 'quick', '--scope', 'docs/**']

test('task add без этапа создаёт задачу пула', () => {
  const dir = tmp()
  run(dir, ['init'])

  const created = run(dir, ['task', 'add', 'Поправить опечатку', ...flags])
  assert.equal(created.code, 0)
  assert.match(created.out, /T1/)

  const shown = run(dir, ['task', 'show', 'T1'])
  assert.equal(shown.code, 0)
  assert.match(shown.out, /T1/)
})

test('task add с этапом создаёт задачу этапа, а не пула', () => {
  const dir = tmp()
  run(dir, ['init'])
  run(dir, ['request', 'add', 'Оплата'])
  run(dir, ['feature', 'add', 'Оплата', '--request', 'R1'])
  run(dir, ['stage', 'add', 'F1', 'S1', '--goal', 'g', '--appetite', '2 дня'])
  run(dir, ['stage', 'activate', 'F1'])

  const created = run(dir, ['task', 'add', 'F1.S1', 'Сделать вебхук', ...flags])
  assert.equal(created.code, 0)
  assert.match(created.out, /F1\.S1-1/)
})

function projectWithPlannedStage() {
  const dir = tmp()
  run(dir, ['init'])
  run(dir, ['request', 'add', 'Оплата'])
  run(dir, ['feature', 'add', 'Оплата', '--request', 'R1'])
  run(dir, ['stage', 'add', 'F1', 'S1', '--goal', 'g', '--appetite', '2 дня'])

  const created = run(dir, ['task', 'add', 'F1.S1', 'Сделать вебхук', ...flags])
  assert.equal(created.code, 0, created.err)
  assert.match(created.out, /F1\.S1-1/)

  return { dir, taskId: 'F1.S1-1' }
}

test('task list показывает planned у задачи неактивного этапа', () => {
  const { dir, taskId } = projectWithPlannedStage()

  const listed = run(dir, ['task', 'list'])
  assert.equal(listed.code, 0, listed.err)
  assert.match(listed.out, new RegExp(`${taskId}\\s+planned`))
  assert.doesNotMatch(listed.out, /ready/)
})

test('task list показывает ready после активации этапа', () => {
  const { dir, taskId } = projectWithPlannedStage()
  run(dir, ['stage', 'activate', 'F1'])

  const listed = run(dir, ['task', 'list'])
  assert.equal(listed.code, 0, listed.err)
  assert.match(listed.out, new RegExp(`${taskId}\\s+ready`))
  assert.doesNotMatch(listed.out, /planned/)
})

// строка фичи: id, прогресс по задачам, статус, название — ширину пробелов не фиксируем.
const stageLine = (featureId: string, progress: string, status: string, name: string) =>
  new RegExp(`${featureId}\\s+${progress}\\s+${status}\\s+${name}`)

test('now считает planned отдельно и не выдаёт задачу за готовую', () => {
  const { dir } = projectWithPlannedStage()

  const view = run(dir, ['now'])
  assert.equal(view.code, 0, view.err)
  assert.match(view.out, stageLine('F1', '0/1', 'pending', 'Оплата'))
  // задача неактивного этапа не попадает в пул: выдавать её за готовую нельзя.
  assert.doesNotMatch(view.out, /ПУЛ/)
})

test('now показывает planned этап, когда предыдущий уже слит', () => {
  const { dir } = projectWithPlannedStage()
  run(dir, ['stage', 'add', 'F1', 'S2', '--goal', 'g', '--appetite', '2 дня'])
  run(dir, ['task', 'add', 'F1.S2', 'Второй шаг', ...flags])

  const db = openDb(join(dir, '.toolbox-al/tracker.db'))
  db.prepare("update stages set status = 'merged' where id = 'F1.S1'").run()
  db.close()

  const view = run(dir, ['now'])
  assert.equal(view.code, 0, view.err)
  assert.match(view.out, stageLine('F1', '0/2', 'pending', 'Оплата'))
  
})

test('активированный этап без движения показан как очередь', () => {
  const { dir } = projectWithPlannedStage()
  run(dir, ['stage', 'activate', 'F1'])

  const view = run(dir, ['now'])
  assert.equal(view.code, 0, view.err)
  assert.match(view.out, stageLine('F1', '0/1', 'pending', 'Оплата'))
})

test('приёмка двигает работу: следующий этап становится активным', () => {
  const { dir } = projectWithPlannedStage()
  run(dir, ['stage', 'add', 'F1', 'S2', '--goal', 'g', '--appetite', '2 дня'])
  run(dir, ['stage', 'activate', 'F1'])

  const db = openDb(join(dir, '.toolbox-al/tracker.db'))
  db.prepare("update stages set acceptance = 'owner' where id = 'F1.S1'").run()
  db.prepare("update tasks set status = 'done' where id = 'F1.S1-1'").run()
  db.close()

  const accepted = run(dir, ['stage', 'accept', 'F1.S1'])
  assert.equal(accepted.code, 0, accepted.err)

  const stages = run(dir, ['stage', 'list', 'F1'])
  assert.match(stages.out, /F1\.S2\s+active/)

  const view = run(dir, ['now'])
  assert.equal(view.code, 0, view.err)
  assert.match(view.out, /ждёт вас: 1/)
})

test('now без этапов показывает фичу с нулевым счётчиком', () => {
  const dir = tmp()
  run(dir, ['init'])
  run(dir, ['request', 'add', 'Оплата'])
  run(dir, ['feature', 'add', 'Оплата', '--request', 'R1'])

  const view = run(dir, ['now'])
  assert.equal(view.code, 0, view.err)
  assert.match(view.out, stageLine('F1', '0/0', 'pending', 'Оплата'))
})

test('now принимает --no-color и печатает без escape-кодов', () => {
  const { dir } = projectWithPlannedStage()
  run(dir, ['stage', 'activate', 'F1'])

  // парсер не должен ругаться на неизвестный флаг
  assert.equal(parseArgs(['now', '--no-color']).flags['no-color'], true)

  const view = run(dir, ['now', '--no-color'])
  assert.equal(view.code, 0, view.err)
  assert.doesNotMatch(view.err, /неизвестный флаг/)
  assert.doesNotMatch(view.out, /\u001b\[/)
  // данные на месте, выключен только цвет
  assert.match(view.out, stageLine('F1', '0/1', 'pending', 'Оплата'))
})


