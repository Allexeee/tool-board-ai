import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const bin = resolve('bin/toolbox-al.ts')

function run(dir: string, args: string[]) {
  const result = spawnSync(process.execPath, [bin, ...args], { cwd: dir, encoding: 'utf8' })
  return { code: result.status, out: result.stdout, err: result.stderr }
}

test('request show --history показывает изменения', () => {
  const dir = mkdtempSync(join(tmpdir(), 'al-req-hist-'))
  run(dir, ['init'])
  run(dir, ['request', 'add', 'Оплата', '--body', 'старый текст'])
  run(dir, ['request', 'edit', 'R1', '--title', 'Оплата подписки'])

  const shown = run(dir, ['request', 'show', 'R1', '--history'])
  assert.equal(shown.code, 0)
  assert.match(shown.out, /Оплата подписки/)
  assert.match(shown.out, /старый текст/)
})

test('история без правок пуста и не падает', () => {
  const dir = mkdtempSync(join(tmpdir(), 'al-req-hist2-'))
  run(dir, ['init'])
  run(dir, ['request', 'add', 'Просто запрос'])

  const shown = run(dir, ['request', 'show', 'R1', '--history'])
  assert.equal(shown.code, 0)
  assert.match(shown.out, /Просто запрос/)
})

test('show печатает фичи, решения и историю', () => {
  const dir = mkdtempSync(join(tmpdir(), 'al-req-show-'))
  run(dir, ['init'])
  run(dir, ['request', 'add', 'Оплата'])
  run(dir, ['feature', 'add', 'Оплата', '--request', 'R1'])
  run(dir, ['decide', 'add', 'Какой провайдер', '--choice', 'ЮKassa', '--reason', 'договор'])

  const shown = run(dir, ['request', 'show', 'R1'])
  assert.equal(shown.code, 0)
  assert.match(shown.out, /F1/)
  assert.match(shown.out, /Решения/)
  assert.match(shown.out, /История/)
})

test('request close закрывает запрос, show печатает причину', () => {
  const dir = mkdtempSync(join(tmpdir(), 'al-req-close-'))
  run(dir, ['init'])
  run(dir, ['request', 'add', 'Уже сделано'])

  const closed = run(dir, ['request', 'close', 'R1', '--reason', 'реализовано в F4'])
  assert.equal(closed.code, 0)

  const shown = run(dir, ['request', 'show', 'R1'])
  assert.match(shown.out, /статус: closed/)
  assert.match(shown.out, /закрыт: реализовано в F4/)
})

test('request show и list печатают дату пересмотра', () => {
  const dir = mkdtempSync(join(tmpdir(), 'al-req-later-'))
  run(dir, ['init'])
  run(dir, ['request', 'add', 'Оплата'])
  run(dir, ['request', 'later', 'R1', '--until', '2026-12-01'])

  const shown = run(dir, ['request', 'show', 'R1'])
  assert.match(shown.out, /пересмотр: 2026-12-01/)

  const listed = run(dir, ['request', 'list'])
  assert.match(listed.out, /до 2026-12-01/)
})

test('request open печатает только незакрытые', () => {
  const dir = mkdtempSync(join(tmpdir(), 'al-req-open-'))
  run(dir, ['init'])
  run(dir, ['request', 'add', 'Открытый'])
  run(dir, ['request', 'add', 'Закрытый'])
  run(dir, ['request', 'close', 'R2', '--reason', 'сделано'])

  const opened = run(dir, ['request', 'open'])
  assert.equal(opened.code, 0)
  assert.match(opened.out, /Открытый/)
  assert.doesNotMatch(opened.out, /Закрытый/)
})

test('request open на пустом срезе говорит об этом', () => {
  const dir = mkdtempSync(join(tmpdir(), 'al-req-open-empty-'))
  run(dir, ['init'])

  const opened = run(dir, ['request', 'open'])
  assert.equal(opened.code, 0)
  assert.match(opened.out, /открытых запросов нет/)
})

test('request open --brief печатает только id и статус', () => {
  const dir = mkdtempSync(join(tmpdir(), 'al-req-open-brief-'))
  run(dir, ['init'])
  run(dir, ['request', 'add', 'Первый'])
  run(dir, ['request', 'add', 'Второй'])

  const brief = run(dir, ['request', 'open', '--brief'])
  assert.equal(brief.code, 0, brief.err)
  assert.deepEqual(brief.out.trimEnd().split('\n'), ['R1    inbox', 'R2    inbox'])
  assert.doesNotMatch(brief.out, /Первый|Второй/)
})

test('request open --brief без открытых запросов говорит об этом', () => {
  const dir = mkdtempSync(join(tmpdir(), 'al-req-open-brief-empty-'))
  run(dir, ['init'])

  const brief = run(dir, ['request', 'open', '--brief'])
  assert.equal(brief.code, 0, brief.err)
  assert.match(brief.out, /открытых запросов нет/)
})

test('request open без флага печатает заголовки как раньше', () => {
  const dir = mkdtempSync(join(tmpdir(), 'al-req-open-full-'))
  run(dir, ['init'])
  run(dir, ['request', 'add', 'Первый'])

  const full = run(dir, ['request', 'open'])
  assert.equal(full.code, 0, full.err)
  assert.match(full.out, /^R1\s+inbox\s+Первый$/m)
})

test('request list показывает вид закрытия', () => {
  const dir = mkdtempSync(join(tmpdir(), 'al-req-kind-'))
  run(dir, ['init'])
  run(dir, ['request', 'add', 'Сделано'])
  run(dir, ['request', 'add', 'Отменено'])
  run(dir, ['request', 'add', 'Поглощено'])
  run(dir, ['request', 'add', 'Цель'])
  run(dir, ['request', 'close', 'R1', '--reason', 'готово'])
  run(dir, ['request', 'close', 'R2', '--reason', 'передумали', '--kind', 'cancelled'])
  run(dir, ['request', 'merge', 'R3', 'R4'])

  const listed = run(dir, ['request', 'list'])
  assert.equal(listed.code, 0)
  assert.match(listed.out, /Сделано\s+\(done\)/)
  assert.match(listed.out, /Отменено\s+\(cancelled\)/)
  assert.match(listed.out, /Поглощено\s+\(объединён\)/)
})

test('запрос без вида печатается как раньше', () => {
  const dir = mkdtempSync(join(tmpdir(), 'al-req-kind-none-'))
  run(dir, ['init'])
  run(dir, ['request', 'add', 'Старое закрытие'])
  const db = new DatabaseSync(join(dir, '.toolbox-al', 'tracker.db'))
  db.prepare("update requests set status = 'closed' where id = 'R1'").run()
  db.close()

  const listed = run(dir, ['request', 'list'])
  assert.equal(listed.code, 0)
  assert.doesNotMatch(listed.out, /\(done\)|\(cancelled\)|\(объединён\)/)
})

test('request show печатает, что запрос в dev', () => {
  const dir = mkdtempSync(join(tmpdir(), 'al-req-land-'))
  run(dir, ['init'])
  run(dir, ['request', 'add', 'Оплата'])
  run(dir, ['feature', 'add', 'Оплата', '--request', 'R1'])
  run(dir, ['stage', 'add', 'F1', 'S1', '--goal', 'g', '--appetite', '1 день'])

  const db = new DatabaseSync(join(dir, '.toolbox-al', 'tracker.db'))
  db.prepare("update stages set status = 'merged', merged_at = ? where id = 'F1.S1'").run(
    new Date().toISOString(),
  )
  db.close()

  const shown = run(dir, ['request', 'show', 'R1'])
  assert.match(shown.out, /залито: dev/)
})

test('у запроса без слияний строки о заливке нет', () => {
  const dir = mkdtempSync(join(tmpdir(), 'al-req-land-none-'))
  run(dir, ['init'])
  run(dir, ['request', 'add', 'Оплата'])

  const shown = run(dir, ['request', 'show', 'R1'])
  assert.doesNotMatch(shown.out, /залито:/)
})

test('request list показывает, где запрос — dev или main', () => {
  const dir = mkdtempSync(join(tmpdir(), 'al-req-list-land-'))
  run(dir, ['init'])
  run(dir, ['request', 'add', 'Оплата'])
  run(dir, ['feature', 'add', 'Оплата', '--request', 'R1'])
  run(dir, ['stage', 'add', 'F1', 'S1', '--goal', 'g', '--appetite', '1 день'])

  const db = new DatabaseSync(join(dir, '.toolbox-al', 'tracker.db'))
  db.prepare("update stages set status = 'merged', merged_at = '2026-01-01T00:00:00.000Z' where id = 'F1.S1'").run()
  db.prepare("update features set status = 'done' where id = 'F1'").run()
  db.close()

  run(dir, ['request', 'close', 'R1', '--reason', 'готово'])

  const before = run(dir, ['request', 'list'])
  assert.match(before.out, /\(done · dev\)/)

  const released = new DatabaseSync(join(dir, '.toolbox-al', 'tracker.db'))
  released
    .prepare('insert into releases (version, tag, changelog, at) values (?, ?, ?, ?)')
    .run('0.2.0', 'v0.2.0', 'x', '2026-06-01T00:00:00.000Z')
  released.close()

  const after = run(dir, ['request', 'list'])
  assert.match(after.out, /\(done · main\)/)
})

test('у запроса без слияний отметки нет и строка не меняется', () => {
  const dir = mkdtempSync(join(tmpdir(), 'al-req-list-noland-'))
  run(dir, ['init'])
  run(dir, ['request', 'add', 'Оплата'])

  const listed = run(dir, ['request', 'list'])
  assert.match(listed.out, /R1\s+inbox\s+Оплата\s*$/)
})

test('у закрытого слиянием запроса строки с причиной нет', () => {
  const dir = mkdtempSync(join(tmpdir(), 'al-req-close2-'))
  run(dir, ['init'])
  run(dir, ['request', 'add', 'Слито'])
  const db = new DatabaseSync(join(dir, '.toolbox-al', 'tracker.db'))
  db.prepare("update requests set status = 'closed' where id = 'R1'").run()
  db.close()

  const shown = run(dir, ['request', 'show', 'R1'])
  assert.equal(shown.code, 0)
  assert.doesNotMatch(shown.out, /закрыт:/)
})

