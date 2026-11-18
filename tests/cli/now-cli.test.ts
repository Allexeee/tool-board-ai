import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { queueColor } from '../../src/cli/commands/now.ts'
import { queueFreeReason, sessionIsWorthShowing, type QueueRow } from '../../src/core/views.ts'

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

/**
 * Живые сессии OpenCode для доски: база лежит во временном XDG_DATA_HOME,
 * настоящую не трогаем. Сессии — дочерние, свежие, из каталога проекта.
 */
function liveSessions(
  dataHome: string,
  rows: Array<{
    id: string
    agent: string
    title: string
    directory: string
    busy: boolean
    updatedAt?: number
  }>,
) {
  mkdirSync(join(dataHome, 'opencode'), { recursive: true })
  const db = new DatabaseSync(join(dataHome, 'opencode', 'opencode.db'))
  db.exec(`
    create table session_v2 (
      id text primary key,
      parent_id text,
      agent text,
      title text,
      directory text,
      time_updated integer,
      time_busy integer,
      time_idle integer,
      time_archived integer
    )
  `)
  const insert = db.prepare(
    'insert into session_v2 (id, parent_id, agent, title, directory, time_updated, time_busy, time_idle, time_archived) ' +
      'values (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  )
  const now = Date.now()
  for (const row of rows) {
    const at = row.updatedAt ?? now
    insert.run(
      row.id,
      'root',
      row.agent,
      row.title,
      row.directory,
      at,
      row.busy ? at : null,
      row.busy ? null : at - 1000,
      null,
    )
  }
  db.close()
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

test('запрос с закрытой фичей не открыт ни в now, ни в request open', () => {
  const dir = project()
  run(dir, ['request', 'add', 'Оплата'])
  run(dir, ['feature', 'add', 'Оплата', '--request', 'R1'])

  const db = new DatabaseSync(join(dir, '.toolbox-al/tracker.db'))
  db.prepare("update features set status = 'done' where id = 'F1'").run()
  db.close()

  const view = run(dir, ['now'])
  assert.equal(view.code, 0, view.err)
  assert.match(view.out, /^\tОткрытых запросов: 0$/m, 'now не считает запрос открытым')

  const open = run(dir, ['request', 'open'])
  assert.equal(open.code, 0, open.err)
  assert.match(open.out, /открытых запросов нет/, 'request open говорит то же')
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
  assert.doesNotMatch(view.out, /ждёт вас/, 'счётчика ожидания владельца больше нет')

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

test('задача на ревью: этап в работе, в очереди причина на ревью', () => {
  const dir = project()
  run(dir, ['request', 'add', 'Платежи'])
  run(dir, ['feature', 'add', 'Платежи', '--request', 'R1'])
  run(dir, ['stage', 'add', 'F1', 'Каркас', '--goal', 'g', '--appetite', '1 день'])
  run(dir, ['task', 'add', 'F1.S1', 'Шаг', '--dod', 'a', '--skill', 'backend', '--scope', 'src/**'])
  run(dir, ['executor', 'add', 'w1', '--skills', 'backend'])

  const db = new DatabaseSync(join(dir, '.toolbox-al/tracker.db'))
  db.prepare("update stages set status = 'active' where id = 'F1.S1'").run()
  db.prepare("update tasks set status = 'in_review', holder = null where id = 'F1.S1-1'").run()
  db.close()

  const view = run(dir, ['now'])
  assert.equal(view.code, 0, view.err)
  assert.match(view.out, /^\tF1\s+0\/1\s+wip\s+Платежи$/m, 'этап в работе, а не pending')
  assert.match(view.out, /F1\.S1-1\s+Шаг · на ревью/)
  assert.doesNotMatch(view.out, /не готова: in_review/)
})

test('пул-задача видна в ОЧЕРЕДИ, отдельного блока ПУЛ нет', () => {
  const dir = project()
  run(dir, ['executor', 'add', 'w1', '--skills', 'backend'])
  run(dir, ['task', 'add', 'Пул', '--dod', 'готово', '--skill', 'backend', '--scope', 'src/**'])

  const view = run(dir, ['now'])
  assert.equal(view.code, 0, view.err)
  assert.doesNotMatch(view.out, /ПУЛ/, 'блока ПУЛ больше нет')

  const rows = view.out.split('\n').filter((line) => line.includes('T1'))
  assert.equal(rows.length, 1, 'задача напечатана один раз — в очереди')
  assert.match(rows[0]!, /T1\s+Пул/)
})

test('now показывает отдыхающего исполнителя и пустую руку', () => {
  const dir = project()
  run(dir, ['executor', 'add', 'w1', '--skills', 'backend'])

  const view = run(dir, ['now'])
  assert.match(view.out, /w1\s+отдыхает/)
})

test('задача в руке не дублируется в очереди', () => {
  const dir = project()
  run(dir, ['executor', 'add', 'w1', '--skills', 'backend'])
  run(dir, ['task', 'add', 'Пул', '--dod', 'готово', '--skill', 'backend', '--scope', 'src/**'])
  run(dir, ['hand', 'set', 'T1', '--as', 'w1'])

  const view = run(dir, ['now'])
  assert.equal(view.code, 0, view.err)
  assert.match(view.out, /ждёт: задача в руке \(T1\)/, 'задача видна у исполнителя')
  assert.doesNotMatch(view.out, /ОЧЕРЕДЬ/, 'свободных задач нет — блока нет')
})

test('now показывает занятость исполнителя как ожидание с причиной и сроком', () => {
  const dir = project()
  run(dir, ['executor', 'add', 'w1', '--skills', 'backend'])

  // --for — тот же срок, что --until: так занятость назначает владелец
  const busy = run(dir, ['executor', 'busy', 'w1', '--note', 'разбор F41', '--for', '30m'])
  assert.equal(busy.code, 0, busy.err)

  const view = run(dir, ['now'])
  assert.equal(view.code, 0, view.err)
  assert.match(view.out, /w1\s+ждёт: разбор F41 \(до \d{2}:\d{2}\)/)
  assert.doesNotMatch(view.out, /w1\s+отдыхает/)
})

test('now различает занятого и отдыхающего исполнителя', () => {
  const dir = project()
  run(dir, ['executor', 'add', 'w1', '--skills', 'backend'])
  run(dir, ['executor', 'add', 'w2', '--skills', 'backend'])
  run(dir, ['executor', 'busy', 'w1', '--note', 'проверка чужой работы', '--until', '1h'])

  const view = run(dir, ['now'])
  assert.equal(view.code, 0, view.err)
  assert.match(view.out, /w1\s+ждёт: проверка чужой работы/)
  assert.match(view.out, /w2\s+отдыхает/)
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
  assert.match(view.out, /w1\s+работает над F1\.S1-1 · Шаг/)
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

test('в очереди только свободные задачи: работа и рука — у исполнителей', () => {
  const dir = project()
  run(dir, ['executor', 'add', 'w1', '--skills', 'backend'])
  run(dir, ['task', 'add', 'В работе', '--dod', 'a', '--skill', 'backend', '--scope', 'src/**'])
  run(dir, ['task', 'add', 'Свободная', '--dod', 'a', '--skill', 'backend', '--scope', 'src/**'])

  const db = new DatabaseSync(join(dir, '.toolbox-al/tracker.db'))
  db.prepare("update tasks set status = 'active', holder = 'w1' where id = 'T1'").run()
  db.close()

  const view = run(dir, ['now'])
  assert.equal(view.code, 0, view.err)
  assert.match(view.out, /работает над T1 · В работе/, 'задача в работе видна у исполнителя')
  assert.match(view.out, /T2\s+Свободная/, 'свободная задача — в очереди')
  assert.doesNotMatch(view.out, /T1\s+В работе/, 'задача в работе в очередь не попадает')
})

test('пустая очередь не печатает блок', () => {
  const dir = project()
  run(dir, ['executor', 'add', 'w1', '--skills', 'backend'])
  run(dir, ['task', 'add', 'Пул', '--dod', 'готово', '--skill', 'backend', '--scope', 'src/**'])
  run(dir, ['hand', 'set', 'T1', '--as', 'w1'])

  const view = run(dir, ['now'])
  assert.equal(view.code, 0, view.err)
  assert.doesNotMatch(view.out, /ОЧЕРЕДЬ/)
})

test('now показывает причину свободной задачи в строке очереди', () => {
  const dir = project()
  run(dir, ['executor', 'add', 'w1', '--skills', 'backend'])
  run(dir, ['task', 'add', 'Пул', '--dod', 'готово', '--skill', 'backend', '--scope', 'src/**'])
  run(dir, ['task', 'add', 'Звук', '--dod', 'готово', '--skill', 'audio', '--scope', 'assets/**'])

  const view = run(dir, ['now'])
  assert.equal(view.code, 0, view.err)

  // причина стоит в строке очереди вместо пустого места
  assert.match(view.out, /T1\s+Пул · ждёт раздачи/)
  assert.match(view.out, /T2\s+Звук · нет исполнителя: audio/)

  // сводки причин внизу больше нет
  assert.doesNotMatch(view.out, /НЕ РАЗДАНО/)
})

test('у задачи в руке нет причины, и в очередь она не попадает', () => {
  const dir = project()
  run(dir, ['executor', 'add', 'w1', '--skills', 'backend'])
  run(dir, ['task', 'add', 'Пул', '--dod', 'готово', '--skill', 'backend', '--scope', 'src/**'])
  run(dir, ['hand', 'set', 'T1', '--as', 'w1'])

  const view = run(dir, ['now'])
  assert.equal(view.code, 0, view.err)
  assert.match(view.out, /ждёт: задача в руке \(T1\)/)
  assert.doesNotMatch(view.out, /ОЧЕРЕДЬ/)
  assert.doesNotMatch(view.out, /ждёт раздачи/)
  assert.doesNotMatch(view.out, /НЕ РАЗДАНО/)
})

test('now не печатает раздачу и счётчик ожидания владельца', () => {
  const dir = project()
  run(dir, ['executor', 'add', 'w1', '--skills', 'backend'])
  run(dir, ['task', 'add', 'Пул', '--dod', 'готово', '--skill', 'backend', '--scope', 'src/**'])
  run(dir, ['hand', 'set', 'T1', '--as', 'w1'])

  const view = run(dir, ['now'])
  assert.equal(view.code, 0, view.err)
  assert.doesNotMatch(view.out, /РАЗДАЧА/)
  assert.doesNotMatch(view.out, /dispatch/)
  assert.doesNotMatch(view.out, /ждёт вас/)
})

test('ЖДЁТ MAIN: свежие фичи сверху', () => {
  const dir = project()
  run(dir, ['feature', 'add', 'Старая'])
  run(dir, ['feature', 'add', 'Новая'])
  run(dir, ['stage', 'add', 'F1', 'Слитый', '--goal', 'g', '--appetite', '1 день'])
  run(dir, ['stage', 'add', 'F2', 'Слитый', '--goal', 'g', '--appetite', '1 день'])

  const db = new DatabaseSync(join(dir, '.toolbox-al/tracker.db'))
  db.prepare("update stages set status = 'merged', merged_at = ? where id = 'F1.S1'").run(
    '2026-11-18T07:00:00.000Z',
  )
  db.prepare("update stages set status = 'merged', merged_at = ? where id = 'F2.S1'").run(
    '2026-11-18T08:00:00.000Z',
  )
  db.close()

  const view = run(dir, ['now'])
  assert.equal(view.code, 0, view.err)
  assert.match(view.out, /^\tЖДЁТ MAIN$/m)
  assert.match(view.out, /^\t {2}F2  Новая$/m)
  assert.match(view.out, /^\t {2}F1  Старая$/m)

  const fresh = view.out.indexOf('F2  Новая')
  const old = view.out.indexOf('F1  Старая')
  assert.ok(fresh !== -1 && old !== -1 && fresh < old, 'свежая фича выше')
})

test('ЖДЁТ MAIN нет, если не все этапы слиты', () => {
  const dir = project()
  run(dir, ['feature', 'add', 'Оплата'])
  run(dir, ['stage', 'add', 'F1', 'Слитый', '--goal', 'g', '--appetite', '1 день'])
  run(dir, ['stage', 'add', 'F1', 'В работе', '--goal', 'g', '--appetite', '1 день'])

  const db = new DatabaseSync(join(dir, '.toolbox-al/tracker.db'))
  db.prepare("update stages set status = 'merged', merged_at = ? where id = 'F1.S1'").run(
    new Date().toISOString(),
  )
  db.close()

  const view = run(dir, ['now'])
  assert.equal(view.code, 0, view.err)
  assert.doesNotMatch(view.out, /ЖДЁТ MAIN/)
})

test('живая занятая сессия даёт работает без задачи и без заголовка', () => {
  const dir = project()
  run(dir, ['executor', 'add', 'w1', '--skills', 'backend'])
  const dataHome = mkdtempSync(join(tmpdir(), 'al-live-'))
  liveSessions(dataHome, [{ id: 'ses_1', agent: 'w1', title: 'шаг по F86', directory: dir, busy: true }])

  const view = run(dir, ['now'], { XDG_DATA_HOME: dataHome })
  assert.equal(view.code, 0, view.err)
  assert.doesNotMatch(view.out, /СУБАГЕНТЫ/, 'отдельного блока субагентов больше нет')
  assert.doesNotMatch(view.out, /шаг по F86/, 'заголовок сессии в строку не попадает')
  assert.match(view.out, /^\t {2}w1\s+работает$/m, 'сессия занята — исполнитель работает')

  const lines = view.out.split('\n').filter((line) => line.includes('w1'))
  assert.equal(lines.length, 1, 'сессия не заводит вторую строку')
})

test('простаивающая сессия исполнителя не делает его работающим', () => {
  const dir = project()
  run(dir, ['executor', 'add', 'w1', '--skills', 'backend'])
  const dataHome = mkdtempSync(join(tmpdir(), 'al-live-'))
  liveSessions(dataHome, [{ id: 'ses_1', agent: 'w1', title: 'шаг', directory: dir, busy: false }])

  const view = run(dir, ['now'], { XDG_DATA_HOME: dataHome })
  assert.equal(view.code, 0, view.err)
  assert.match(view.out, /^\t {2}w1\s+отдыхает$/m, 'простаивающая сессия — не работа')
})

test('живая сессия без исполнителя видна, только пока занята', () => {
  const dir = project()
  run(dir, ['executor', 'add', 'w1', '--skills', 'backend'])
  const dataHome = mkdtempSync(join(tmpdir(), 'al-live-'))
  liveSessions(dataHome, [
    { id: 'ses_1', agent: 'w1', title: 'шаг', directory: dir, busy: true },
    { id: 'ses_2', agent: 'general', title: 'Ревью', directory: dir, busy: true },
  ])

  const view = run(dir, ['now'], { XDG_DATA_HOME: dataHome })
  assert.equal(view.code, 0, view.err)
  assert.doesNotMatch(view.out, /СУБАГЕНТЫ/)
  assert.match(view.out, /^\t {2}general\s+работает$/m, 'занятая сессия без исполнителя — своя строка')
  assert.doesNotMatch(view.out, /Ревью/, 'заголовок сессии не печатается')

  const header = view.out.indexOf('ИСПОЛНИТЕЛИ')
  const session = view.out.indexOf('general')
  assert.ok(header !== -1 && session > header, 'сессия стоит в списке исполнителей, а не отдельным блоком')
})

test('сессия без исполнителя видна только занятой и свежей', () => {
  const now = Date.now()
  const session = (busy: boolean, agoMs: number) => ({
    id: 's',
    agent: 'general',
    title: 'Ревью',
    busy,
    updatedAt: now - agoMs,
  })

  assert.equal(sessionIsWorthShowing(session(true, 60_000), now), true, 'занята и обновлялась минуту назад')
  assert.equal(sessionIsWorthShowing(session(false, 60_000), now), false, 'простаивает — не печатаем')
  assert.equal(sessionIsWorthShowing(session(true, 20 * 60_000), now), false, 'старая — не печатаем')
})

test('простаивающая сессия без исполнителя не печатается', () => {
  const dir = project()
  run(dir, ['executor', 'add', 'w1', '--skills', 'backend'])
  const dataHome = mkdtempSync(join(tmpdir(), 'al-live-'))
  liveSessions(dataHome, [{ id: 'ses_2', agent: 'build', title: 'Сборка', directory: dir, busy: false }])

  const view = run(dir, ['now'], { XDG_DATA_HOME: dataHome })
  assert.equal(view.code, 0, view.err)
  assert.doesNotMatch(view.out, /build/, 'простаивающая сессия ничего не говорит владельцу')
})

test('старая занятая сессия без исполнителя не печатается', () => {
  const dir = project()
  run(dir, ['executor', 'add', 'w1', '--skills', 'backend'])
  const dataHome = mkdtempSync(join(tmpdir(), 'al-live-'))
  liveSessions(dataHome, [
    // занята, но обновлялась 20 минут назад: для доски это уже история
    { id: 'ses_2', agent: 'general', title: 'Ревью', directory: dir, busy: true, updatedAt: Date.now() - 20 * 60 * 1000 },
  ])

  const view = run(dir, ['now'], { XDG_DATA_HOME: dataHome })
  assert.equal(view.code, 0, view.err)
  assert.doesNotMatch(view.out, /general/, 'старая сессия не печатается, даже если занята')
})

test('задача в руке без блокировки: ожидание называет её, а не упрекает', () => {
  const dir = project()
  run(dir, ['executor', 'add', 'w1', '--skills', 'backend'])
  run(dir, ['task', 'add', 'Пул', '--dod', 'готово', '--skill', 'backend', '--scope', 'src/**'])
  run(dir, ['hand', 'set', 'T1', '--as', 'w1'])

  const view = run(dir, ['now'])
  assert.equal(view.code, 0, view.err)
  assert.match(view.out, /w1\s+ждёт: задача в руке \(T1\)/)
  assert.doesNotMatch(view.out, /не взял/)
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





