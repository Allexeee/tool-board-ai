import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { queueColor } from '../../src/cli/commands/now.ts'
import { queueFreeReason, type QueueRow } from '../../src/core/views.ts'

const bin = resolve('bin/toolbox-al.ts')

function run(dir: string, args: string[], env: Record<string, string> = {}) {
  const result = spawnSync(process.execPath, [bin, ...args], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, ...env },
    windowsHide: true,
  })
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
  assert.match(view.out, /^\tОткрытых запросов: 1$/m)
  assert.match(view.out, /^\tF1\s+0\/0\s+pending\s+Оплата$/m)
})

test('слитый этап остаётся в таблице как done, блока ожидания нет', () => {
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
  assert.match(view.out, /^\tF1\s+0\/0\s+done\s+Оплата$/m)
  assert.doesNotMatch(view.out, /ОЖИДАЕТ РЕЛИЗА|НЕ ВЫПУЩЕНО|release pending/)
})

test('now на пустом проекте говорит, что работы нет', () => {
  const dir = project()
  const view = run(dir, ['now'])

  assert.equal(view.code, 0, view.err)
  assert.match(view.out, /^\tОткрытых запросов: 0$/m)
  assert.match(view.out, /фич в работе нет/)
})

test('now идёт после пустой строки и с табуляцией в каждой строке', () => {
  const dir = project()
  run(dir, ['request', 'add', 'Первый'])
  run(dir, ['request', 'add', 'Второй'])

  const view = run(dir, ['now'])
  assert.equal(view.code, 0, view.err)

  const lines = view.out.split('\n')
  assert.equal(lines[0], '', 'первая строка пустая')
  assert.equal(lines[1], '\tОткрытых запросов: 2')
  assert.match(lines[2], /^\tждёт вас: \d+$/)

  const content = lines.filter((line) => line.trim() !== '')
  for (const line of content) {
    assert.match(line, /^\t/, `строка без табуляции: ${line}`)
  }
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
  db.prepare(
    "update tasks set status = 'active', holder = 'w1' where id = (select min(id) from tasks where stage_id = 'F1.S2')",
  ).run()
  db.close()

  const view = run(dir, ['now'])
  assert.equal(view.code, 0, view.err)
  assert.match(view.out, /^\tF1\s+0\/2\s+wip\s+Платежи$/m)
  assert.match(view.out, /^\tF1\s+0\/2\s+wip\s+Платежи$/m)

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

  assert.doesNotMatch(run(dir, ['now']).out, /\[1\/1\]\s+0\/0\s+done\s+Слитый/)
  assert.match(run(dir, ['now', '--all']).out, /^\tF1\s+0\/0\s+done\s+Оплата$/m)
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
  assert.match(view.out, /w1\s+свободен/)
})

test('now показывает очередь руки исполнителя', () => {
  const dir = project()
  run(dir, ['executor', 'add', 'w1', '--skills', 'backend'])
  run(dir, ['task', 'add', 'Пул', '--dod', 'готово', '--skill', 'backend', '--scope', 'src/**'])
  run(dir, ['task', 'list'])
  run(dir, ['hand', 'set', 'T1', '--as', 'w1'])

  const view = run(dir, ['now'])
  assert.match(view.out, /T1\s+w1\s+Пул/)
})

test('now показывает занятость исполнителя: причину и срок', () => {
  const dir = project()
  run(dir, ['executor', 'add', 'w1', '--skills', 'backend'])

  // --for — тот же срок, что --until: так занятость назначает владелец
  const busy = run(dir, ['executor', 'busy', 'w1', '--note', 'разбор F41', '--for', '30m'])
  assert.equal(busy.code, 0, busy.err)

  const view = run(dir, ['now'])
  assert.equal(view.code, 0, view.err)
  assert.match(view.out, /w1\s+занят: разбор F41 \(до \d{2}:\d{2}\)/)
  assert.doesNotMatch(view.out, /w1\s+свободен/)
})

test('now различает занятого и свободного исполнителя', () => {
  const dir = project()
  run(dir, ['executor', 'add', 'w1', '--skills', 'backend'])
  run(dir, ['executor', 'add', 'w2', '--skills', 'backend'])
  run(dir, ['executor', 'busy', 'w1', '--note', 'проверка чужой работы', '--until', '1h'])

  const view = run(dir, ['now'])
  assert.equal(view.code, 0, view.err)
  assert.match(view.out, /w1\s+занят: проверка чужой работы/)
  assert.match(view.out, /w2\s+свободен/)
})

test('now в пайпе печатает чистый текст без escape-последовательностей', () => {
  const dir = project()
  run(dir, ['request', 'add', 'Платежи'])
  run(dir, ['feature', 'add', 'Платежи', '--request', 'R1'])
  run(dir, ['stage', 'add', 'F1', 'Каркас', '--goal', 'g', '--appetite', '1 день'])
  run(dir, ['task', 'add', 'F1.S1', 'Шаг', '--dod', 'a', '--skill', 'backend', '--scope', 'src/**'])
  run(dir, ['executor', 'add', 'w1', '--skills', 'backend'])

  const db = new DatabaseSync(join(dir, '.toolbox-al/tracker.db'))
  db.prepare("update stages set status = 'active' where id = 'F1.S1'").run()
  db.prepare("update tasks set status = 'active', holder = 'w1' where id = 'F1.S1-1'").run()
  db.close()

  const view = run(dir, ['now'])
  assert.equal(view.code, 0, view.err)
  assert.doesNotMatch(view.out, /\u001b\[/)
  assert.match(view.out, /^\tF1\s+0\/1\s+wip\s+Платежи$/m)
  assert.match(view.out, /w1\s+держит F1\.S1-1/)
})

test('now --json не добавляет цветовых кодов', () => {
  const dir = project()
  run(dir, ['feature', 'add', 'Оплата'])

  const view = run(dir, ['now', '--json'])
  assert.equal(view.code, 0, view.err)
  assert.doesNotMatch(view.out, /\u001b\[/)
  assert.doesNotThrow(() => JSON.parse(view.out))
})

test('now с NO_COLOR печатает чистый текст', () => {
  const dir = project()
  run(dir, ['feature', 'add', 'Оплата'])

  const view = run(dir, ['now'], { NO_COLOR: '1' })
  assert.equal(view.code, 0, view.err)
  assert.doesNotMatch(view.out, /\u001b\[/)
  assert.match(view.out, /Оплата/)
})

test('now показывает причину свободной задачи и сводку НЕ РАЗДАНО', () => {
  const dir = project()
  run(dir, ['executor', 'add', 'w1', '--skills', 'backend'])
  run(dir, ['task', 'add', 'Пул', '--dod', 'готово', '--skill', 'backend', '--scope', 'src/**'])
  run(dir, ['task', 'add', 'Звук', '--dod', 'готово', '--skill', 'audio', '--scope', 'assets/**'])

  const view = run(dir, ['now'])
  assert.equal(view.code, 0, view.err)

  // причина стоит в строке очереди вместо пустого места
  assert.match(view.out, /T1\s+свободна\s+Пул · ждёт раздачи/)
  assert.match(view.out, /T2\s+свободна\s+Звук · нет исполнителя: audio/)

  // внизу — сводка: сколько задач на каждую причину
  assert.match(view.out, /^\tНЕ РАЗДАНО$/m)
  assert.match(view.out, /^\t {2}ждёт раздачи\s+1$/m)
  assert.match(view.out, /^\t {2}нет исполнителя: audio\s+1$/m)
})

test('у назначенной задачи причины нет, и сводка её не считает', () => {
  const dir = project()
  run(dir, ['executor', 'add', 'w1', '--skills', 'backend'])
  run(dir, ['task', 'add', 'Пул', '--dod', 'готово', '--skill', 'backend', '--scope', 'src/**'])
  run(dir, ['hand', 'set', 'T1', '--as', 'w1'])

  const view = run(dir, ['now'])
  assert.equal(view.code, 0, view.err)
  assert.match(view.out, /T1\s+w1\s+Пул/)
  assert.doesNotMatch(view.out, /ждёт раздачи/)
  assert.doesNotMatch(view.out, /НЕ РАЗДАНО/)
})

test('now показывает раздачу: dispatch, руками и без выдачи', () => {
  const dir = project()
  run(dir, ['executor', 'add', 'w1', '--skills', 'backend'])
  run(dir, ['task', 'add', 'Пул', '--dod', 'готово', '--skill', 'backend', '--scope', 'src/**'])
  run(dir, ['hand', 'set', 'T1', '--as', 'w1'])

  const view = run(dir, ['now'])
  assert.equal(view.code, 0, view.err)
  assert.match(view.out, /^\tРАЗДАЧА$/m)
  assert.match(view.out, /^\t {2}за всё время\s+dispatch 0 · руками 1 · без выдачи 0$/m)
  assert.doesNotMatch(view.out, /за прогон/, 'прогонов не было — строку про прогон не печатаем')
})

test('now показывает раздачу за прогон', () => {
  const dir = project()
  run(dir, ['executor', 'add', 'w1', '--skills', 'backend'])
  run(dir, ['task', 'add', 'Пул', '--dod', 'готово', '--skill', 'backend', '--scope', 'src/**'])
  run(dir, ['run', 'start', '--mode', 'plan'])
  run(dir, ['hand', 'set', 'T1', '--as', 'w1'])

  const view = run(dir, ['now'])
  assert.equal(view.code, 0, view.err)
  assert.match(view.out, /^\t {2}за прогон\s+dispatch 0 · руками 1 · без выдачи 0$/m)
  assert.match(view.out, /^\t {2}за всё время\s+dispatch 0 · руками 1 · без выдачи 0$/m)
})

test('цвет очереди: зелёный — брать, жёлтый — в руке, циан — в работе, серый — ждёт', () => {
  const base: QueueRow = {
    taskId: 'T1',
    title: 'Шаг',
    status: 'ready',
    featureId: null,
    stageId: null,
    waitsFor: [],
    holder: null,
    hand: null,
    reason: queueFreeReason,
  }

  assert.equal(queueColor(base), 'green', 'готовую к взятию — зелёным')
  assert.equal(queueColor({ ...base, hand: 'w1', reason: null }), 'yellow', 'в руке — жёлтым')
  assert.equal(queueColor({ ...base, status: 'active', holder: 'w1', reason: null }), 'cyan', 'в работе — цианом')
  assert.equal(queueColor({ ...base, waitsFor: ['T0'], reason: 'ждёт T0' }), 'gray', 'ждёт зависимости — серым')
  assert.equal(queueColor({ ...base, reason: 'нет исполнителя: audio' }), 'gray', 'некому брать — тоже ждёт')
})





