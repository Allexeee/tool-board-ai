import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb, type DatabaseSync } from '../../src/core/db.ts'
import { endRun, getRunRecord, startRun } from '../../src/core/runs.ts'
import {
  effectivePower,
  hibernateSupported,
  planRunPower,
  reportFile,
  schedulePower,
  setRunPower,
  type CommandResult,
} from '../../src/core/power.ts'

/** Настоящие shutdown и powercfg в тестах не зовутся: шпион записывает команды. */
function spy() {
  const calls: Array<{ command: string; args: string[] }> = []
  const runner = (command: string, args: string[]): CommandResult => {
    calls.push({ command, args })
    return { status: 0, output: '' }
  }
  return { calls, runner }
}

function root(): string {
  const dir = mkdtempSync(join(tmpdir(), 'al-power-'))
  mkdirSync(join(dir, '.toolbox-al', 'reports'), { recursive: true })
  return dir
}

function writeReport(dir: string, runId: string): string {
  const path = join(dir, '.toolbox-al', 'reports', `${runId}-2026-11-18.md`)
  writeFileSync(path, `# Прогон ${runId}\n`, 'utf8')
  return path
}

function closedRun(db: DatabaseSync, power: 'none' | 'hibernate' | 'shutdown' = 'hibernate') {
  const run = startRun(db, { mode: 'plan', power, now: new Date('2026-11-18T08:00:00.000Z') })
  return endRun(db, { id: run.id, reason: 'tasks', now: new Date('2026-11-18T20:00:00.000Z') })
}

test('run end --power запоминает питание в записи прогона', () => {
  const db = openDb(':memory:')
  const ended = closedRun(db, 'none')
  assert.equal(ended.power, 'none')

  const updated = setRunPower(db, { runId: ended.id, power: 'shutdown', actor: 'owner' })
  assert.equal(updated.power, 'shutdown')
  assert.equal(getRunRecord(db, ended.id)?.power, 'shutdown', 'питание легло в базу')

  // правка питания видна в журнале, а не только в колонке
  const event = db
    .prepare("select before, after from events where type = 'run.power' order by id desc limit 1")
    .get() as { before: string; after: string }
  assert.equal((JSON.parse(event.before) as { power: string }).power, 'none')
  assert.equal((JSON.parse(event.after) as { power: string }).power, 'shutdown')

  assert.throws(() => setRunPower(db, { runId: ended.id, power: 'sleep' as 'none' }), /none, hibernate или shutdown/)
})

test('гибернация недоступна — выполняется выключение', () => {
  assert.equal(effectivePower('hibernate', true), 'hibernate')
  assert.equal(effectivePower('hibernate', false), 'shutdown')
  assert.equal(effectivePower('shutdown', true), 'shutdown')
  assert.equal(effectivePower('none', true), 'none')

  // powercfg /a перечисляет состояния сна; вывод локализован
  assert.equal(hibernateSupported('The following sleep states are available: Hibernate'), true)
  assert.equal(hibernateSupported('Доступны следующие состояния сна:\n    Гибернация'), true)
  assert.equal(hibernateSupported('S0 Low Power Idle\nS3\nFast Startup'), false)

  const db = openDb(':memory:')
  const run = closedRun(db, 'hibernate')
  const dir = root()
  const report = writeReport(dir, run.id)

  const plan = planRunPower(db, dir, run.id, { hibernateAvailable: false })
  assert.equal(plan.requested, 'hibernate')
  assert.equal(plan.action, 'shutdown')
  assert.equal(plan.reportPath, report)
  assert.match(plan.note ?? '', /гибернация недоступна/)

  const available = planRunPower(db, dir, run.id, { hibernateAvailable: true })
  assert.equal(available.action, 'hibernate')
  assert.equal(available.note, null)
})

test('питание без отчёта не выполняется', () => {
  const db = openDb(':memory:')
  const run = closedRun(db, 'hibernate')
  const dir = root()

  // отчёта нет: питание обязано отказать, а не гасить машину без бумаг
  assert.throws(
    () => planRunPower(db, dir, run.id, { hibernateAvailable: true }),
    /отчёта прогона RUN1 нет/,
  )
  assert.equal(reportFile(dir, run.id), null)

  writeReport(dir, run.id)
  assert.ok(reportFile(dir, run.id), 'после run report питание разрешено')
  assert.equal(planRunPower(db, dir, run.id, { hibernateAvailable: true }).action, 'hibernate')
})

test('питание не заказано или прогон идёт — отказы', () => {
  const db = openDb(':memory:')
  const dir = root()

  const open = startRun(db, { mode: 'plan', power: 'shutdown' })
  writeReport(dir, open.id)
  assert.throws(
    () => planRunPower(db, dir, open.id, { hibernateAvailable: true }),
    /ещё идёт/,
  )

  endRun(db, { id: open.id, reason: 'tasks' })
  const quiet = closedRun(db, 'none')
  writeReport(dir, quiet.id)
  assert.throws(
    () => planRunPower(db, dir, quiet.id, { hibernateAvailable: true }),
    /питание не заказано/,
  )
})

test('гибернация ждёт локальный таймер и отменяется без команд', async () => {
  const { calls, runner } = spy()
  const ticks: number[] = []
  const controller = new AbortController()

  const outcome = await schedulePower({
    action: 'hibernate',
    runner,
    seconds: 90,
    signal: controller.signal,
    onTick: (left) => {
      ticks.push(left)
      if (left === 88) controller.abort()
    },
  })

  assert.equal(outcome, 'cancelled')
  assert.deepEqual(ticks, [90, 89, 88], 'отсчёт идёт от 90 по секунде')
  assert.deepEqual(calls, [], 'отмена не зовёт shutdown')
})

test('гибернация по таймеру зовёт shutdown /h, выключение — shutdown /s /t 0', async () => {
  const hibernate = spy()
  const outcome = await schedulePower({
    action: 'hibernate',
    runner: hibernate.runner,
    seconds: 0,
  })
  assert.equal(outcome, 'hibernate')
  assert.deepEqual(hibernate.calls, [{ command: 'shutdown', args: ['/h'] }])

  const shutdown = spy()
  const second = await schedulePower({ action: 'shutdown', runner: shutdown.runner, seconds: 90 })
  assert.equal(second, 'shutdown')
  assert.deepEqual(shutdown.calls, [{ command: 'shutdown', args: ['/s', '/t', '0'] }])
})

test('питание none ничего не делает', async () => {
  const { calls, runner } = spy()
  const ticks: number[] = []

  const outcome = await schedulePower({ action: 'none', runner, seconds: 90, onTick: (left) => ticks.push(left) })

  assert.equal(outcome, 'none')
  assert.deepEqual(ticks, [])
  assert.deepEqual(calls, [])
})
