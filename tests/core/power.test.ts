import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { openDb, type DatabaseSync } from '../../src/core/db.ts'
import { endRun, getRunRecord, startRun } from '../../src/core/runs.ts'
import {
  effectivePower,
  hibernateFile,
  hibernateInstalled,
  hibernateSupported,
  orderRunPower,
  planRunPower,
  reportFile,
  schedulePower,
  setRunPower,
  type CommandResult,
} from '../../src/core/power.ts'
import { makeRepo } from '../helpers/repo.ts'

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

/** Проверка файла без диска: видит только те пути, что ей назвали. */
function disk(exists: boolean) {
  const seen: string[] = []
  const hasFile = (path: string) => {
    seen.push(path)
    return exists
  }
  return { seen, hasFile }
}

test('гибернация считается доступной только при наличии hiberfil.sys', () => {
  // путь — от системного диска из окружения: hiberfil.sys не всегда на C:
  const file = hibernateFile({ SystemDrive: 'D:' })
  assert.match(file, /^D:[\\/]+hiberfil\.sys$/)
  assert.equal(hibernateFile({ SystemDrive: 'D:\\' }), file, 'хвостовой слеш не ломает путь')

  // файла нет — гибернации нет, даже если powercfg /a её упоминает
  const missing = disk(false)
  assert.equal(hibernateInstalled(missing.hasFile, { SystemDrive: 'D:' }), false)
  assert.equal(missing.seen.at(-1), file, 'спрашивают именно файл на системном диске')
  assert.equal(
    hibernateSupported('Доступны следующие состояния сна:\n    Гибернация', missing.hasFile),
    false,
    'текст powercfg /a не делает гибернацию доступной',
  )

  // файл на месте — гибернация есть
  assert.equal(hibernateInstalled(disk(true).hasFile, { SystemDrive: 'D:' }), true)
  assert.equal(hibernateSupported('', disk(true).hasFile), true)

  // без инжекции смотрим системный диск из окружения, а не выдуманный C:
  assert.match(hibernateFile(), /hiberfil\.sys$/)
})

test('файла гибернации нет — план выбирает выключение, файл есть — гибернацию', () => {
  const db = openDb(':memory:')
  const run = closedRun(db, 'hibernate')
  const dir = root()
  const report = writeReport(dir, run.id)

  // гибернации нет: выключаемся, и план называет причину
  const withoutFile = planRunPower(db, dir, run.id, {
    hibernateAvailable: hibernateInstalled(disk(false).hasFile),
  })
  assert.equal(withoutFile.requested, 'hibernate')
  assert.equal(withoutFile.action, 'shutdown')
  assert.equal(withoutFile.reportPath, report)
  assert.match(withoutFile.note ?? '', /гибернация недоступна/)
  assert.match(withoutFile.note ?? '', /hiberfil\.sys/, 'в причине назван файл')

  // файл на месте — остаётся гибернация, замечания нет
  const available = planRunPower(db, dir, run.id, {
    hibernateAvailable: hibernateInstalled(disk(true).hasFile),
  })
  assert.equal(available.action, 'hibernate')
  assert.equal(available.note, null)
})

test('effectivePower переводит гибернацию в выключение, остальное не трогает', () => {
  assert.equal(effectivePower('hibernate', true), 'hibernate')
  assert.equal(effectivePower('hibernate', false), 'shutdown')
  assert.equal(effectivePower('shutdown', true), 'shutdown')
  assert.equal(effectivePower('none', true), 'none')
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
  const second = await schedulePower({ action: 'shutdown', runner: shutdown.runner, seconds: 0 })
  assert.equal(second, 'shutdown')
  assert.deepEqual(shutdown.calls, [{ command: 'shutdown', args: ['/s', '/t', '0'] }])
})

test('выключение ждёт тот же таймер и отменяется без команд', async () => {
  const { calls, runner } = spy()
  const ticks: Array<[number, string]> = []
  const controller = new AbortController()

  const outcome = await schedulePower({
    action: 'shutdown',
    runner,
    seconds: 3,
    signal: controller.signal,
    onTick: (left, action) => {
      ticks.push([left, action])
      if (left === 1) controller.abort()
    },
  })

  assert.equal(outcome, 'cancelled')
  assert.deepEqual(
    ticks,
    [
      [3, 'shutdown'],
      [2, 'shutdown'],
      [1, 'shutdown'],
    ],
    'отсчёт идёт и для выключения, действие названо в тике',
  )
  assert.deepEqual(calls, [], 'отмена не зовёт shutdown')
})

test('питание none ничего не делает', async () => {
  const { calls, runner } = spy()
  const ticks: number[] = []

  const outcome = await schedulePower({ action: 'none', runner, seconds: 90, onTick: (left) => ticks.push(left) })

  assert.equal(outcome, 'none')
  assert.deepEqual(ticks, [])
  assert.deepEqual(calls, [])
})

test('run end --power закрывает прогон с заказом одним шагом', () => {
  const db = openDb(':memory:')
  const dir = root()
  const run = startRun(db, { mode: 'plan', power: 'none' })

  const ended = endRun(db, { id: run.id, reason: 'tasks', power: 'hibernate' })
  assert.equal(ended.power, 'hibernate', 'заказ лёг в запись вместе с концом')
  assert.ok(ended.endedAt, 'прогон закрыт')
  assert.equal(getRunRecord(db, run.id)?.power, 'hibernate')

  // и дальше работает обычный путь: бумаги, потом питание
  const report = writeReport(dir, run.id)
  const plan = planRunPower(db, dir, run.id, { hibernateAvailable: true })
  assert.equal(plan.requested, 'hibernate')
  assert.equal(plan.reportPath, report)

  // повторный run power не ломается: заказ уже на месте
  assert.equal(orderRunPower(db, { runId: run.id, power: 'hibernate' }).power, 'hibernate')
})

test('неверное питание на конце не закрывает прогон', () => {
  const db = openDb(':memory:')
  const run = startRun(db, { mode: 'plan' })

  // проверка заказа стоит до записи: прогон остаётся открытым, а не закрытым без питания
  assert.throws(
    () => endRun(db, { id: run.id, reason: 'tasks', power: 'sleep' as 'none' }),
    /none, hibernate или shutdown/,
  )

  const record = getRunRecord(db, run.id)!
  assert.equal(record.endedAt, null, 'прогон ещё идёт')
  assert.equal(record.endReason, null)
  assert.equal(record.power, 'none')

  // отказ ничего не испортил: обычный end проходит
  assert.ok(endRun(db, { id: run.id, reason: 'tasks' }).endedAt)
})

test('run power --power заказывает питание закрытому прогону', () => {
  const db = openDb(':memory:')
  const dir = root()

  // end без питания: подсказка run power --power должна работать, а не упираться в «второй end»
  const quiet = closedRun(db, 'none')
  const ordered = orderRunPower(db, { runId: quiet.id, power: 'shutdown', actor: 'owner' })
  assert.equal(ordered.power, 'shutdown')

  const event = db
    .prepare("select before, after from events where type = 'run.power' order by id desc limit 1")
    .get() as { before: string; after: string }
  assert.equal((JSON.parse(event.before) as { power: string }).power, 'none')
  assert.equal((JSON.parse(event.after) as { power: string }).power, 'shutdown')

  // отчёт по-прежнему обязателен: заказ — намерение, исполнение ждёт бумаг
  assert.throws(
    () => planRunPower(db, dir, quiet.id, { hibernateAvailable: true }),
    /отчёта прогона RUN1 нет/,
  )

  writeReport(dir, quiet.id)
  assert.equal(planRunPower(db, dir, quiet.id, { hibernateAvailable: true }).action, 'shutdown')

  assert.throws(
    () => orderRunPower(db, { runId: quiet.id, power: 'sleep' as 'none' }),
    /none, hibernate или shutdown/,
  )
})

test('run power --power открытому прогону отказывает', () => {
  const db = openDb(':memory:')
  const open = startRun(db, { mode: 'plan', power: 'none' })

  assert.throws(
    () => orderRunPower(db, { runId: open.id, power: 'shutdown' }),
    /ещё идёт/,
  )
  assert.equal(getRunRecord(db, open.id)?.power, 'none', 'отказ не поставил заказ')
  assert.equal(getRunRecord(db, open.id)?.endedAt, null)
})

// ─── тот же путь через CLI ──────────────────────────────────────────────────
//
// run power на win32 зовёт powercfg /a — это чтение, а не выключение. Все
// проверки ниже отказывают до shutdown, поэтому настоящая машина не гаснет.

const bin = resolve('bin/toolbox-al.ts')

function runCli(dir: string, args: string[]) {
  const result = spawnSync(process.execPath, [bin, ...args], { cwd: dir, encoding: 'utf8' })
  return { code: result.status, out: result.stdout ?? '', err: result.stderr ?? '' }
}

test(
  'CLI: end --power и run power --power дают заказ, отчёт остаётся обязательным',
  { skip: process.platform === 'win32' ? false : 'питание сделано для Windows' },
  () => {
    const dir = makeRepo()
    const init = runCli(dir, ['init'])
    assert.equal(init.code, 0, init.err)

    const dbPath = join(dir, '.toolbox-al', 'tracker.db')
    const powerOf = (id: string) => {
      const db = openDb(dbPath)
      try {
        return getRunRecord(db, id)!
      } finally {
        db.close()
      }
    }

    // 1. end с питанием: заказ лёг вместе с концом
    assert.equal(runCli(dir, ['run', 'start', '--mode', 'plan']).code, 0)
    const ended = runCli(dir, ['run', 'end', 'RUN1', '--reason', 'tasks', '--power', 'hibernate'])
    assert.equal(ended.code, 0, ended.err)
    assert.match(ended.out, /питание: гибернация/)
    assert.equal(powerOf('RUN1').power, 'hibernate')
    assert.ok(powerOf('RUN1').endedAt)

    // 2. заказ переставляется на закрытом прогоне, но без отчёта не исполняется
    const reordered = runCli(dir, ['run', 'power', 'RUN1', '--power', 'shutdown'])
    assert.equal(reordered.code, 1)
    assert.match(reordered.err, /отчёта прогона RUN1 нет/)
    assert.equal(powerOf('RUN1').power, 'shutdown')

    // 3. end без питания: подсказка run power --power ведёт к делу, а не в тупик
    assert.equal(runCli(dir, ['run', 'start', '--mode', 'plan']).code, 0)
    assert.equal(runCli(dir, ['run', 'end', 'RUN2', '--reason', 'owner']).code, 0)
    const hint = runCli(dir, ['run', 'power', 'RUN2'])
    assert.equal(hint.code, 1)
    assert.match(hint.err, /run power RUN2 --power hibernate\|shutdown/)

    const ordered = runCli(dir, ['run', 'power', 'RUN2', '--power', 'hibernate'])
    assert.equal(ordered.code, 1)
    assert.match(ordered.err, /отчёта прогона RUN2 нет/)
    assert.equal(powerOf('RUN2').power, 'hibernate')

    // 4. неверное питание на конце прогон не закрывает
    assert.equal(runCli(dir, ['run', 'start', '--mode', 'plan']).code, 0)
    const bad = runCli(dir, ['run', 'end', 'RUN3', '--reason', 'tasks', '--power', 'sleep'])
    assert.equal(bad.code, 3)
    assert.match(bad.err, /none, hibernate или shutdown/)
    assert.equal(powerOf('RUN3').endedAt, null, 'прогон остался открытым')
  },
)
