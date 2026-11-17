import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const bin = resolve('bin/toolbox-al.ts')

function run(dir: string, args: string[]) {
  const result = spawnSync(process.execPath, [bin, ...args], { cwd: dir, encoding: 'utf8' })
  return { code: result.status, out: result.stdout, err: result.stderr }
}

function project() {
  const dir = mkdtempSync(join(tmpdir(), 'al-now-'))
  run(dir, ['init'])
  return dir
}

test('now показывает только последнюю версию плана', () => {
  const dir = project()
  run(dir, ['request', 'add', 'Оплата'])
  const file = join(dir, 'plan.json')
  const body = JSON.stringify({
    title: 'Оплата',
    assumptions: [],
    stages: [
      {
        name: 'Каркас',
        goal: 'g',
        appetite: '1 день',
        steps: [{ title: 'Шаг', skill: 'backend', size: 'S', dod: ['a'], scope: ['src/**'] }],
      },
    ],
  })
  writeFileSync(file, body, 'utf8')
  run(dir, ['plan', 'new', 'R1', file])
  run(dir, ['plan', 'new', 'R1', file])

  const view = run(dir, ['now'])
  assert.match(view.out, /P2/)
  assert.doesNotMatch(view.out, /P1\s/)
})

test('now не показывает план закрытого запроса', () => {
  const dir = project()
  run(dir, ['request', 'add', 'Оплата'])
  const file = join(dir, 'plan.json')
  writeFileSync(
    file,
    JSON.stringify({
      title: 'Оплата',
      assumptions: [],
      stages: [
        {
          name: 'Каркас',
          goal: 'g',
          appetite: '1 день',
          steps: [{ title: 'Шаг', skill: 'backend', size: 'S', dod: ['a'], scope: ['src/**'] }],
        },
      ],
    }),
    'utf8',
  )
  run(dir, ['plan', 'new', 'R1', file])
  run(dir, ['request', 'close', 'R1', '--reason', 'передумали'])

  const view = run(dir, ['now'])
  assert.doesNotMatch(view.out, /ПЛАНЫ НА УТВЕРЖДЕНИЕ/)
})

test('now считает запросы в inbox и показывает фичу без этапов', () => {
  const dir = project()
  run(dir, ['request', 'add', 'Оплата'])
  run(dir, ['feature', 'add', 'Оплата', '--request', 'R1'])

  const view = run(dir, ['now'])
  assert.equal(view.code, 0, view.err)
  assert.match(view.out, /^Открытых запросов: 1$/m)
  assert.match(view.out, /^F1\s+\[0\/0\]\s+0\/0\s+pending\s+Оплата$/m)
})

test('now показывает, сколько этапов не выпущено', () => {
  const dir = project()
  run(dir, ['request', 'add', 'Оплата'])
  run(dir, ['feature', 'add', 'Оплата', '--request', 'R1'])
  run(dir, ['stage', 'add', 'F1', 'S1', '--goal', 'g', '--appetite', '1 день'])

  const db = new DatabaseSync(join(dir, '.toolbox-al/tracker.db'))
  db.prepare("update stages set status = 'merged', merged_at = ? where id = 'F1.S1'").run(
    new Date().toISOString(),
  )
  db.close()

  const view = run(dir, ['now'])
  assert.match(view.out, /НЕ ВЫПУЩЕНО/)
  assert.match(view.out, /release pending/)
})

test('now на пустом проекте говорит, что работы нет', () => {
  const dir = project()
  const view = run(dir, ['now'])

  assert.equal(view.code, 0, view.err)
  assert.match(view.out, /^Открытых запросов: 0$/m)
  assert.match(view.out, /фич в работе нет/)
})

test('now первой строкой печатает число открытых запросов', () => {
  const dir = project()
  run(dir, ['request', 'add', 'Первый'])
  run(dir, ['request', 'add', 'Второй'])

  const view = run(dir, ['now'])
  assert.equal(view.code, 0, view.err)
  assert.equal(view.out.split('\n')[0], 'Открытых запросов: 2')
})

test('now печатает этапы таблицей: готовые, в работе, очередь', () => {
  const dir = project()
  run(dir, ['request', 'add', 'Платежи'])
  run(dir, ['feature', 'add', 'Платежи', '--request', 'R1'])
  run(dir, ['stage', 'add', 'F1', 'Каркас', '--goal', 'g', '--appetite', '1 день'])
  run(dir, ['stage', 'add', 'F1', 'Проводка', '--goal', 'g', '--appetite', '1 день'])
  run(dir, ['stage', 'add', 'F1', 'Отчёты', '--goal', 'g', '--appetite', '1 день'])
  run(dir, ['task', 'add', 'F1.S2', 'Первая', '--dod', 'a', '--skill', 'backend', '--scope', 'src/**'])
  run(dir, ['task', 'add', 'F1.S2', 'Вторая', '--dod', 'a', '--skill', 'backend', '--scope', 'src/**'])

  const db = new DatabaseSync(join(dir, '.toolbox-al/tracker.db'))
  db.prepare("update stages set status = 'merged' where id = 'F1.S1'").run()
  db.prepare("update stages set status = 'active' where id = 'F1.S2'").run()
  db.close()

  const view = run(dir, ['now'])
  assert.equal(view.code, 0, view.err)
  assert.match(view.out, /^F1\s+\[1\/3\]\s+0\/0\s+done\s+Каркас$/m)
  assert.match(view.out, /^F1\s+\[2\/3\]\s+1\/2\s+wip\s+Проводка$/m)
  assert.match(view.out, /^F1\s+\[3\/3\]\s+0\/0\s+pending\s+Отчёты$/m)
  assert.doesNotMatch(view.out, /В РАБОТЕ|ГОТОВО К ЗАЛИВКЕ|^ФИЧИ$/m)
})

test('now прячет завершённые фичи, а --all показывает', () => {
  const dir = project()
  run(dir, ['feature', 'add', 'Сделано'])
  const db = new DatabaseSync(join(dir, '.toolbox-al/tracker.db'))
  db.prepare("update features set status = 'done' where id = 'F1'").run()
  db.close()

  const hidden = run(dir, ['now'])
  assert.doesNotMatch(hidden.out, /Сделано/)
  assert.match(hidden.out, /фич в работе нет/)

  const all = run(dir, ['now', '--all'])
  assert.match(all.out, /Сделано/)
})

test('now --all показывает готовый этап завершённой фичи', () => {
  const dir = project()
  run(dir, ['request', 'add', 'Оплата'])
  run(dir, ['feature', 'add', 'Оплата', '--request', 'R1'])
  run(dir, ['stage', 'add', 'F1', 'Слитый', '--goal', 'g', '--appetite', '1 день'])

  const db = new DatabaseSync(join(dir, '.toolbox-al/tracker.db'))
  db.prepare("update stages set status = 'merged' where id = 'F1.S1'").run()
  db.prepare("update features set status = 'done' where id = 'F1'").run()
  db.close()

  assert.doesNotMatch(run(dir, ['now']).out, /Слитый/)
  assert.match(run(dir, ['now', '--all']).out, /^F1\s+\[1\/1\]\s+0\/0\s+done\s+Слитый$/m)
})

test('now показывает фичу в работе', () => {
  const dir = project()
  run(dir, ['feature', 'add', 'В работе'])

  const view = run(dir, ['now'])
  assert.match(view.out, /В работе/)
})

test('now показывает решение рядом с фичей', () => {
  const dir = project()
  run(dir, ['feature', 'add', 'Оплата'])
  run(dir, ['decide', 'add', 'Провайдер', '--choice', 'ЮKassa', '--reason', 'договор', '--subject', 'F1'])

  const view = run(dir, ['now'])
  assert.match(view.out, /Провайдер → ЮKassa/)
})

test('фича без решений печатается как раньше', () => {
  const dir = project()
  run(dir, ['feature', 'add', 'Без решений'])

  const view = run(dir, ['now'])
  assert.doesNotMatch(view.out, /→/)
})

test('now показывает свободного исполнителя и пустую руку', () => {
  const dir = project()
  run(dir, ['executor', 'add', 'w1', '--skills', 'backend'])

  const view = run(dir, ['now'])
  assert.match(view.out, /w1\s+свободен · рука пуста/)
})

test('now показывает очередь руки исполнителя', () => {
  const dir = project()
  run(dir, ['executor', 'add', 'w1', '--skills', 'backend'])
  run(dir, ['task', 'add', 'Пул', '--dod', 'готово', '--skill', 'backend', '--scope', 'src/**'])
  run(dir, ['task', 'list'])
  run(dir, ['hand', 'set', 'T1', '--as', 'w1'])

  const view = run(dir, ['now'])
  assert.match(view.out, /w1\s+свободен · рука: T1/)
})

