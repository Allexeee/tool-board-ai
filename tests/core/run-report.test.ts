import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb, type DatabaseSync } from '../../src/core/db.ts'
import { addRequest } from '../../src/core/requests.ts'
import { addFeature } from '../../src/core/features.ts'
import { addStage } from '../../src/core/stages.ts'
import { addDecision } from '../../src/core/decisions.ts'
import { ask } from '../../src/core/questions.ts'
import { createTask } from '../../src/core/tasks.ts'
import { endRun, startRun } from '../../src/core/runs.ts'
import { collectRunReport, writeRunReport } from '../../src/core/run-report.ts'

function root(): string {
  return mkdtempSync(join(tmpdir(), 'al-report-'))
}

/** Фича с этапом, который фича уже слила в dev. */
function mergedStage(db: DatabaseSync, mergedAt: string) {
  const request = addRequest(db, { title: 'RUN в инструменте', body: 'прогон как запись', author: 'owner' })
  const feature = addFeature(db, { requestId: request.id, name: 'RUN в инструменте', rank: 1 })
  const stage = addStage(db, {
    featureId: feature.id,
    name: 'run start',
    goal: 'прогон пишется в базу',
    appetite: 'день',
  })

  db.prepare("update stages set status = 'merged', merged_at = ? where id = ?").run(mergedAt, stage.id)
  return { request, feature, stage }
}

test('отчёт прогона перечисляет слитый этап и лежит файлом', () => {
  const db = openDb(':memory:')
  const { feature, stage } = mergedStage(db, '2026-11-18T10:00:00.000Z')

  // цена считается по задачам фичи: одна закрыта, одна отложена
  const first = createTask(db, {
    stageId: stage.id,
    title: 'run start пишет прогон',
    dod: ['строка в базе'],
    size: 'S',
    skill: 'backend',
    class: 'standard',
    scope: ['src/core/runs.ts'],
  })
  const second = createTask(db, {
    stageId: stage.id,
    title: 'run show печатает прогон',
    dod: ['строка на экране'],
    size: 'S',
    skill: 'backend',
    class: 'standard',
    scope: ['src/cli/commands/run.ts'],
  })
  db.prepare("update tasks set status = 'done' where id = ?").run(first.id)
  db.prepare("update tasks set status = 'deferred' where id = ?").run(second.id)

  const run = startRun(db, { mode: 'plan', now: new Date('2026-11-18T08:00:00.000Z') })
  endRun(db, { id: run.id, reason: 'tasks', now: new Date('2026-11-18T20:00:00.000Z') })

  const report = writeRunReport(db, run.id, {
    root: root(),
    now: new Date('2026-11-18T21:00:00.000Z'),
  })

  assert.ok(existsSync(report.path), `отчёт должен лежать файлом: ${report.path}`)
  const normalized = report.path.replace(/\\/g, '/')
  assert.match(normalized, /\.toolbox-al\/reports\/RUN1-\d{4}-\d{2}-\d{2}\.md$/)

  // дата в имени файла — местная дата старта, та же, что в шапке отчёта
  const started = new Date('2026-11-18T08:00:00.000Z')
  const pad = (value: number) => String(value).padStart(2, '0')
  const localDay = `${started.getFullYear()}-${pad(started.getMonth() + 1)}-${pad(started.getDate())}`
  assert.ok(normalized.endsWith(`RUN1-${localDay}.md`), normalized)

  const text = readFileSync(report.path, 'utf8')
  assert.match(text, /^# Прогон RUN1/m)
  assert.match(text, /## Сделано/)
  assert.match(text, new RegExp(stage.id.replace('.', '\\.')))
  assert.match(text, /run start/)
  assert.match(text, new RegExp(feature.id))

  // этап в dev, но не в main: он же попадает в ожидание залития с ценой
  assert.match(text, /## Ждёт залития в main/)
  assert.match(text, /задач 2 \(закрыто 1, отложено 1\)/)
  assert.match(text, /- конец: задачи · нужно ревью/)
})

test('пустой прогон даёт шапку без разделов-пустышек', () => {
  const db = openDb(':memory:')
  const run = startRun(db, { mode: 'plan' })

  const report = writeRunReport(db, run.id, { root: root() })

  assert.ok(existsSync(report.path))
  const text = readFileSync(report.path, 'utf8')

  assert.match(text, /^# Прогон RUN1/m)
  assert.match(text, /режим: по плану/)
  assert.match(text, /запросы: не выбраны/)

  for (const heading of ['Сделано', 'Ждёт залития в main', 'Нужны решения владельца', 'Взятые допущения']) {
    assert.doesNotMatch(text, new RegExp('## ' + heading), `пустой раздел «${heading}» не печатается`)
  }

  // отчёт пустого прогона — это только шапка
  assert.equal(text.trim().split('\n')[0], '# Прогон RUN1')
})

test('отчёт называет нужные владельцу решения и взятые допущения', () => {
  const db = openDb(':memory:')
  const { feature } = mergedStage(db, '2026-11-18T10:00:00.000Z')

  addDecision(db, {
    question: 'Где хранить прогон?',
    choice: 'в таблице runs',
    reason: 'журнал событий уже перегружен',
    subjectId: feature.id,
    author: 'worker-2',
  })
  ask(db, {
    addressee: 'owner',
    text: 'Питание после прогона: гибернация или выключение?',
    subjectType: 'request',
    subjectId: feature.requestId ?? feature.id,
    deadline: '2026-11-20T09:00:00.000Z',
  })

  const run = startRun(db, { mode: 'all', now: new Date('2026-11-18T08:00:00.000Z') })

  const data = collectRunReport(db, run.id, { now: new Date('2026-11-18T21:00:00.000Z') })
  assert.equal(data.pending.length, 1)
  assert.equal(data.pending[0].cost.featureId, feature.id)
  assert.equal(data.assumptions.length, 1)
  assert.equal(data.waitingOwner.length, 1)

  const report = writeRunReport(db, run.id, { root: root() })
  const text = readFileSync(report.path, 'utf8')

  assert.match(text, /## Нужны решения владельца/)
  assert.match(text, /вопрос Q1: «Питание после прогона/)
  assert.match(text, /## Взятые допущения/)
  assert.match(text, /«Где хранить прогон\?» → «в таблице runs»/)
  assert.match(text, /почему: журнал событий уже перегружен/)
})

test('отчёт неизвестного прогона — отказ, файл не создаётся', () => {
  const db = openDb(':memory:')
  const dir = root()

  assert.throws(() => writeRunReport(db, 'RUN9', { root: dir }), /прогон RUN9 не найден/)
  assert.equal(existsSync(join(dir, '.toolbox-al', 'reports')), false)
})
