import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { migrate, openDb, type DatabaseSync } from '../../src/core/db.ts'
import { SCHEMA_VERSION } from '../../src/core/schema.ts'
import { addRequest } from '../../src/core/requests.ts'
import { addFeature, setFeatureBranch } from '../../src/core/features.ts'
import { addStage } from '../../src/core/stages.ts'
import { createTask, getTask } from '../../src/core/tasks.ts'
import { ask } from '../../src/core/questions.ts'
import { listEvents } from '../../src/core/events.ts'
import { getRunRecord, startRun } from '../../src/core/runs.ts'
import {
  collectHandoff,
  latestHandoff,
  renderResumeBrief,
  resumeRun,
  writeHandoff,
} from '../../src/core/handoff.ts'

function root(): string {
  return mkdtempSync(join(tmpdir(), 'al-handoff-'))
}

/**
 * Прогон в середине работы: этап с закрытой задачей уже слит в dev, вторая
 * задача в руках исполнителя на активном этапе. Ровно тот случай, ради
 * которого эстафета.
 */
function halfway(db: DatabaseSync) {
  const run = startRun(db, { mode: 'plan', now: new Date('2026-11-18T08:00:00.000Z') })

  const request = addRequest(db, { title: 'Эстафета прогона', body: 'прогон переезжает', author: 'owner' })
  const feature = addFeature(db, { requestId: request.id, name: 'Эстафета прогона', rank: 1 })
  setFeatureBranch(db, feature.id, 'feat/f81-estafeta-progona', 'D:/tmp/f81-estafeta-progona')
  const stage = addStage(db, {
    featureId: feature.id,
    name: 'run handoff',
    goal: 'состояние снимается в файл',
    appetite: 'день',
  })
  const activeStage = addStage(db, {
    featureId: feature.id,
    name: 'run resume',
    goal: 'новая сессия подхватывает прогон',
    appetite: 'день',
  })
  db.prepare("update stages set status = 'active' where id = ?").run(activeStage.id)

  const finished = createTask(db, {
    stageId: stage.id,
    title: 'run handoff пишет файл',
    dod: ['файл на диске'],
    size: 'S',
    skill: 'backend',
    class: 'standard',
    scope: ['src/core/handoff.ts'],
  })
  db.prepare("update tasks set status = 'done' where id = ?").run(finished.id)

  const active = createTask(db, {
    stageId: activeStage.id,
    title: 'run resume читает файл',
    dod: ['новая сессия продолжает'],
    size: 'M',
    skill: 'backend',
    class: 'standard',
    scope: ['src/cli/commands/run.ts'],
  })
  db.prepare(
    "update tasks set status = 'active', holder = 'worker-1', lease_until = ? where id = ?",
  ).run('2026-11-18T14:00:00.000Z', active.id)

  // этап ушёл в dev уже после старта прогона: это и есть «сделано»
  db.prepare("update stages set status = 'merged', merged_at = ? where id = ?").run(
    '2026-11-18T10:00:00.000Z',
    stage.id,
  )

  return { run, request, feature, stage, activeStage, finished, active }
}

test('эстафета снимает сделанное и работу в руках, json и md лежат файлами', () => {
  const db = openDb(':memory:')
  const { run, feature, stage, finished, active } = halfway(db)

  const dir = root()
  const handoff = writeHandoff(db, run.id, { root: dir, now: new Date('2026-11-18T12:00:00.000Z') })

  // первый сегмент — тот, в котором прогон начат
  assert.equal(handoff.segment, 1)

  assert.ok(existsSync(handoff.jsonPath), `json должен лежать файлом: ${handoff.jsonPath}`)
  assert.ok(existsSync(handoff.mdPath), `md должен лежать файлом: ${handoff.mdPath}`)
  assert.match(handoff.jsonPath.replace(/\\/g, '/'), /\.toolbox-al\/reports\/RUN1-handoff\.json$/)
  assert.match(handoff.mdPath.replace(/\\/g, '/'), /\.toolbox-al\/reports\/RUN1-handoff\.md$/)

  const json = JSON.parse(readFileSync(handoff.jsonPath, 'utf8')) as {
    segment: number
    done: Array<{ stageId: string; featureId: string }>
    inWork: Array<{ id: string; holder: string | null; leaseUntil: string | null; worktree: string | null }>
    queue: unknown[]
    owner: unknown[]
    nextStep: string
  }

  assert.equal(json.segment, 1)
  assert.deepEqual(json.done.map((row) => row.stageId), [stage.id])
  assert.equal(json.done[0]!.featureId, feature.id)

  // в работе — задача, держатель, каталог и аренда, а не только id
  assert.deepEqual(json.inWork.map((row) => row.id), [active.id])
  assert.equal(json.inWork[0]!.holder, 'worker-1')
  assert.equal(json.inWork[0]!.leaseUntil, '2026-11-18T14:00:00.000Z')
  assert.equal(json.inWork[0]!.worktree, 'D:/tmp/f81-estafeta-progona')
  assert.equal(json.queue.length, 0)
  assert.equal(json.owner.length, 0)
  assert.match(json.nextStep, new RegExp(active.id.replace('.', '\\.')))

  const text = readFileSync(handoff.mdPath, 'utf8')
  assert.match(text, /^# Эстафета прогона RUN1 · сегмент 1/m)
  assert.match(text, /## Сделано[\s\S]*run handoff/)
  assert.match(text, new RegExp(stage.id.replace('.', '\\.')))
  assert.match(text, /## В работе[\s\S]*run resume читает файл/)
  assert.match(text, /worker-1/)
  assert.match(text, /D:\/tmp\/f81-estafeta-progona/)
  assert.match(text, /аренда до \d{2}\.\d{2}\.\d{4} \d{2}:\d{2}/)

  // закрытая задача в «сделано» не попадает: она не этап
  assert.doesNotMatch(text, new RegExp(finished.id.replace('.', '\\.')))
})

test('каждый handoff увеличивает сегмент: 1 → 2 после второго вызова', () => {
  const db = openDb(':memory:')
  const { run } = halfway(db)
  const dir = root()

  const first = writeHandoff(db, run.id, { root: dir, now: new Date('2026-11-18T12:00:00.000Z') })
  assert.equal(first.segment, 1)
  assert.equal(getRunRecord(db, run.id)!.segment, 2, 'сегмент вырос в базе')

  const second = writeHandoff(db, run.id, { root: dir, now: new Date('2026-11-18T13:00:00.000Z') })
  assert.equal(second.segment, 2, 'второй файл снимает следующий сегмент')
  assert.equal(getRunRecord(db, run.id)!.segment, 3)

  const json = JSON.parse(readFileSync(second.jsonPath, 'utf8')) as { segment: number }
  assert.equal(json.segment, 2)

  // сдвиг сегмента виден в журнале: кто снял эстафету и что дальше
  const events = listEvents(db, { subject: run.id }).filter((event) => event.type === 'run.handoff')
  assert.deepEqual(
    events.map((event) => JSON.parse(event.after ?? '{}').segment),
    [1, 2],
  )
})

test('в эстафету попадают очередь готовых и решения владельца', () => {
  const db = openDb(':memory:')
  const { run, activeStage, active } = halfway(db)

  const queued = createTask(db, {
    stageId: activeStage.id,
    title: 'run report по сегментам',
    dod: ['отчёт знает сегменты'],
    size: 'S',
    skill: 'backend',
    class: 'standard',
    scope: ['src/core/run-report.ts'],
  })
  db.prepare("update tasks set status = 'ready' where id = ?").run(queued.id)

  const question = ask(db, {
    addressee: 'owner',
    text: 'Куда девать файл эстафеты после закрытия прогона?',
    subjectType: 'task',
    subjectId: active.id,
  })

  const handoff = writeHandoff(db, run.id, { root: root() })

  assert.deepEqual(handoff.queue.map((row) => row.id), [queued.id])
  assert.deepEqual(handoff.owner.map((item) => item.id), [question.id])
  assert.match(handoff.nextStep, /дождаться владельца/)
  assert.match(handoff.nextStep, new RegExp(question.id))
})

test('закрытому прогону эстафета не пишется: файлов не появляется', () => {
  const db = openDb(':memory:')
  const { run } = halfway(db)
  const dir = root()

  db.prepare('update runs set ended_at = ?, end_reason = ? where id = ?').run(
    '2026-11-18T20:00:00.000Z',
    'tasks',
    run.id,
  )

  assert.throws(() => collectHandoff(db, run.id), /уже закрыт .*: эстафета пишется по идущему прогону/s)
  assert.throws(() => writeHandoff(db, run.id, { root: dir }), /эстафета пишется по идущему прогону/)
  assert.equal(existsSync(join(dir, '.toolbox-al', 'reports')), false)
})

test('неизвестный прогон — отказ без файлов', () => {
  const db = openDb(':memory:')
  const dir = root()

  assert.throws(() => writeHandoff(db, 'RUN9', { root: dir }), /прогон RUN9 не найден/)
  assert.equal(existsSync(join(dir, '.toolbox-al', 'reports')), false)
})

test('миграция 12 → 13 добавляет сегмент и не теряет прогоны', () => {
  const dir = mkdtempSync(join(tmpdir(), 'al-v12-'))
  const path = join(dir, 'tracker.db')
  const old = openDb(path)

  const run = startRun(old, { mode: 'plan', now: new Date('2026-11-18T08:00:00.000Z') })

  // приводим базу к схеме 12: колонки segment ещё нет
  old.exec('alter table runs drop column segment')
  old.prepare("update meta set value = '12' where key = 'schemaVersion'").run()
  old.close()

  assert.throws(() => openDb(path), /устарела/)

  const db = openDb(path, { allowOutdated: true })
  assert.equal(migrate(db), SCHEMA_VERSION)

  const column = db.prepare("select 1 as found from pragma_table_info('runs') where name = 'segment'").get()
  assert.ok(column, 'у прогона есть колонка segment')

  const kept = getRunRecord(db, run.id)
  assert.ok(kept, 'прогон пережил миграцию')
  assert.equal(kept!.startedAt, '2026-11-18T08:00:00.000Z')
  assert.equal(kept!.segment, 1, 'старый прогон — первый сегмент, а не потерянный')
  db.close()
})

// ─── подхват: resume сверяет файл с базой ───────────────────────────────────

test('resume возвращает в ready задачу с истёкшей арендой и говорит об этом', () => {
  const db = openDb(':memory:')
  const { run, active } = halfway(db)
  const dir = root()

  // эстафета снята, пока аренда ещё жива: 14:00
  writeHandoff(db, run.id, { root: dir, now: new Date('2026-11-18T13:00:00.000Z') })
  assert.equal(getTask(db, active.id)!.status, 'active')

  // новая сессия приходит через час после истечения аренды
  const brief = resumeRun(db, { root: dir, now: new Date('2026-11-18T15:00:00.000Z') })

  const task = getTask(db, active.id)!
  assert.equal(task.status, 'ready', 'мёртвая аренда вернула задачу в очередь')
  assert.equal(task.holder, null)
  assert.equal(task.leaseUntil, null)
  assert.deepEqual(brief.released, [active.id])
  assert.ok(brief.queue.some((row) => row.id === active.id), 'задача снова в очереди')
  assert.deepEqual(brief.inWork, [])

  const text = renderResumeBrief(brief)
  assert.match(text, /аренда истекла/)
  assert.match(text, new RegExp(active.id.replace('.', '\\.')))
  assert.match(text, /вернул в очередь 1/)

  // бриф — на 10–15 строк, а не пересказ файла
  const lines = text.split('\n')
  assert.ok(lines.length >= 10 && lines.length <= 15, `строк в брифе: ${lines.length}\n${text}`)
  assert.match(lines[0]!, /^RUN1 · сегмент 2 · эстафета из сегмента 1/)
  assert.match(lines.at(-1)!, /^следующий шаг: взять из очереди/)

  // истечение видно в журнале, а resume не двигает сегмент — двигает handoff
  const expired = listEvents(db, { subject: active.id }).filter((event) => event.type === 'task.lease_expired')
  assert.equal(expired.length, 1)
  assert.equal(getRunRecord(db, run.id)!.segment, 2)
  assert.equal(brief.segment, 2)
  assert.equal(brief.fromSegment, 1)
})

test('resume возвращает в ready задачу, которая выпала из работы', () => {
  const db = openDb(':memory:')
  const { run, active } = halfway(db)
  const dir = root()

  writeHandoff(db, run.id, { root: dir, now: new Date('2026-11-18T13:00:00.000Z') })

  // старая сессия умерла на середине: задачу отпустили, но не довели до очереди
  db.prepare("update tasks set status = 'open', holder = null, lease_until = null where id = ?").run(active.id)

  const brief = resumeRun(db, { root: dir, now: new Date('2026-11-18T13:30:00.000Z') })

  // «не в работе» — это ready: часы прогона ставят её в очередь, resume это фиксирует
  assert.equal(getTask(db, active.id)!.status, 'ready')
  assert.ok(brief.queue.some((row) => row.id === active.id), 'задача снова в очереди')
  assert.match(renderResumeBrief(brief), /уже в очереди/)
})

test('закрытую задачу resume не воскрешает', () => {
  const db = openDb(':memory:')
  const { run, active } = halfway(db)
  const dir = root()

  writeHandoff(db, run.id, { root: dir, now: new Date('2026-11-18T13:00:00.000Z') })
  db.prepare("update tasks set status = 'done', holder = null, lease_until = null where id = ?").run(active.id)

  const brief = resumeRun(db, { root: dir, now: new Date('2026-11-18T15:00:00.000Z') })

  assert.equal(getTask(db, active.id)!.status, 'done', 'сделанное не возвращается в очередь')
  assert.deepEqual(brief.released, [])
  assert.match(renderResumeBrief(brief), /закрыта/)
})

test('resume без handoff-файла — честный отказ с подсказкой', () => {
  const db = openDb(':memory:')
  const dir = root()

  assert.throws(() => resumeRun(db, { root: dir }), /handoff-файла нет:.*run handoff/s)
  assert.equal(latestHandoff(dir), null)
})

test('resume закрытого прогона не подхватывает', () => {
  const db = openDb(':memory:')
  const { run } = halfway(db)
  const dir = root()

  writeHandoff(db, run.id, { root: dir, now: new Date('2026-11-18T13:00:00.000Z') })
  db.prepare('update runs set ended_at = ?, end_reason = ? where id = ?').run(
    '2026-11-18T20:00:00.000Z',
    'tasks',
    run.id,
  )

  assert.throws(() => resumeRun(db, { root: dir }), /уже закрыт: подхватывать нечего.*run report RUN1/s)
})

