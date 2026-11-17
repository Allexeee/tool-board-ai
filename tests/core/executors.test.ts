import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '../../src/core/db.ts'
import {
  addExecutor,
  assertSkill,
  busyOf,
  clearBusy,
  DEFAULT_STEPS,
  getExecutor,
  listExecutors,
  normalizeSteps,
  parseBusyUntil,
  parsePermissions,
  removeExecutor,
  renameExecutor,
  setBusy,
  setModel,
  setPermissions,
  setSkills,
  setSteps,
} from '../../src/core/executors.ts'
import { createTask, getTask } from '../../src/core/tasks.ts'
import { refreshReady } from '../../src/core/deps.ts'
import { takeTask } from '../../src/core/lease.ts'
import { getHand, setHand } from '../../src/core/hands.ts'
import { listEvents } from '../../src/core/events.ts'

const lastEvent = (db: ReturnType<typeof openDb>, subject: string) => {
  const events = listEvents(db, { subject })
  return events[events.length - 1]
}

test('исполнитель хранит набор навыков и wip', () => {
  const db = openDb(':memory:')
  const e = addExecutor(db, { id: 'w1', kind: 'agent', skills: ['backend', 'design'] })
  assert.deepEqual(e.skills, ['backend', 'design'])
  assert.equal(e.wipLimit, 1)
})

test('неизвестный навык даёт понятную ошибку', () => {
  const db = openDb(':memory:')
  const e = addExecutor(db, { id: 'w1', kind: 'agent', skills: ['backend'] })
  assert.throws(() => assertSkill(e, 'audio'), /навык audio не найден/)
})

test('повторное добавление того же исполнителя отвергается', () => {
  const db = openDb(':memory:')
  addExecutor(db, { id: 'w1', kind: 'agent', skills: ['backend'] })
  assert.throws(() => addExecutor(db, { id: 'w1', kind: 'agent', skills: ['backend'] }), /уже есть/)
})

test('добавление исполнителя пишется в журнал', () => {
  const db = openDb(':memory:')
  addExecutor(db, { id: 'w1', kind: 'agent', skills: ['backend'] })
  assert.equal(listEvents(db, { subject: 'w1' })[0].type, 'executor.added')
})

test('getExecutor возвращает null для неизвестного', () => {
  const db = openDb(':memory:')
  assert.equal(getExecutor(db, 'nobody'), null)
})

test('rename переносит id в задачах и руке', () => {
  const db = openDb(':memory:')
  addExecutor(db, { id: 'old', kind: 'agent', skills: ['backend'] })
  const task = createTask(db, {
    title: 'Правка',
    dod: ['a'],
    size: 'S',
    skill: 'backend',
    class: 'standard',
    scope: ['src/**'],
  })
  refreshReady(db)
  takeTask(db, { executor: 'old', taskId: task.id })
  setHand(db, 'old', [], 'owner')

  const renamed = renameExecutor(db, { from: 'old', to: 'worker-0', actor: 'owner' })

  assert.equal(renamed.id, 'worker-0')
  assert.equal(getTask(db, task.id)!.holder, 'worker-0')
})

test('remove отказывает при активной задаче', () => {
  const db = openDb(':memory:')
  addExecutor(db, { id: 'w1', kind: 'agent', skills: ['backend'] })
  const task = createTask(db, {
    title: 'Правка',
    dod: ['a'],
    size: 'S',
    skill: 'backend',
    class: 'standard',
    scope: ['src/**'],
  })
  refreshReady(db)
  takeTask(db, { executor: 'w1', taskId: task.id })

  assert.throws(() => removeExecutor(db, { executorId: 'w1', actor: 'owner' }), /активная/)
})

test('remove освобождает руку и удаляет исполнителя', () => {
  const db = openDb(':memory:')
  addExecutor(db, { id: 'w1', kind: 'agent', skills: ['backend'] })
  const task = createTask(db, {
    title: 'Правка',
    dod: ['a'],
    size: 'S',
    skill: 'backend',
    class: 'standard',
    scope: ['src/**'],
  })
  refreshReady(db)
  setHand(db, 'w1', [task.id], 'owner')

  removeExecutor(db, { executorId: 'w1', actor: 'owner' })

  assert.equal(listExecutors(db).length, 0)
  assert.deepEqual(getHand(db, 'w1'), [])
})

test('skills заменяет список', () => {
  const db = openDb(':memory:')
  addExecutor(db, { id: 'w1', kind: 'agent', skills: ['backend'] })

  const updated = setSkills(db, { executorId: 'w1', skills: ['frontend', 'design'], actor: 'owner' })
  assert.deepEqual(updated.skills, ['frontend', 'design'])
})

test('по умолчанию модель наследуется, прав нет, шагов 60', () => {
  const db = openDb(':memory:')
  const e = addExecutor(db, { id: 'w1', kind: 'agent', skills: ['backend'] })

  assert.equal(DEFAULT_STEPS, 60)
  assert.equal(e.model, null)
  assert.deepEqual(e.permissions, [])
  assert.equal(e.steps, 60)
})

test('новый исполнитель без явного лимита читается с дефолтом 60, в том числе из файла базы', () => {
  const dir = mkdtempSync(join(tmpdir(), 'al-executors-'))
  const path = join(dir, 'queue.db')
  const db = openDb(path)
  addExecutor(db, { id: 'w1', kind: 'agent', skills: ['backend'] })
  db.close()

  // повторное открытие — это чтение существующего исполнителя, из которого sync берёт шаги
  const reopened = openDb(path)
  assert.equal(getExecutor(reopened, 'w1')!.steps, 60)
  assert.equal(listExecutors(reopened)[0].steps, 60)
  reopened.close()
  rmSync(dir, { recursive: true, force: true })
})

test('явный лимит шагов сохраняется при чтении и меняется через setSteps', () => {
  const db = openDb(':memory:')
  addExecutor(db, { id: 'w1', kind: 'agent', skills: ['backend'], steps: 30 })

  assert.equal(getExecutor(db, 'w1')!.steps, 30)
  assert.equal(listExecutors(db)[0].steps, 30)

  const changed = setSteps(db, { executorId: 'w1', steps: 90, actor: 'owner' })
  assert.equal(changed.steps, 90)
  assert.equal(getExecutor(db, 'w1')!.steps, 90)

  // прежняя явная двадцатка — это выбор владельца, а не дефолт: чтение её не подменяет
  setSteps(db, { executorId: 'w1', steps: 20, actor: 'owner' })
  assert.equal(getExecutor(db, 'w1')!.steps, 20)
})

test('границы лимита шагов прежние: 1..500 включительно', () => {
  const db = openDb(':memory:')

  assert.equal(addExecutor(db, { id: 'low', kind: 'agent', skills: ['backend'], steps: 1 }).steps, 1)
  assert.equal(addExecutor(db, { id: 'high', kind: 'agent', skills: ['backend'], steps: 500 }).steps, 500)
  assert.equal(normalizeSteps('60'), 60)
  assert.equal(normalizeSteps(undefined), 60)

  assert.throws(() => normalizeSteps(0), /от 1/)
  assert.throws(() => normalizeSteps(501), /от 1/)
  assert.throws(() => normalizeSteps(2.5), /целое/)
  assert.throws(() => normalizeSteps('  '), /целое/)
})

test('новая база задаёт дефолт шагов 60 самой схемой', () => {
  const db = openDb(':memory:')
  // мимо API: проверяем именно default колонки, а не normalizeSteps
  db.prepare('insert into executors (id, kind, skills) values (?, ?, ?)').run(
    'w1',
    'agent',
    JSON.stringify(['backend']),
  )

  assert.equal(getExecutor(db, 'w1')!.steps, 60)
  assert.equal(listExecutors(db)[0].steps, 60)
})

test('испорченное значение шагов в базе читается как дефолт', () => {
  const db = openDb(':memory:')
  addExecutor(db, { id: 'w1', kind: 'agent', skills: ['backend'] })

  db.prepare('update executors set steps = 0 where id = ?').run('w1')
  assert.equal(getExecutor(db, 'w1')!.steps, 60)

  db.prepare('update executors set steps = 9000 where id = ?').run('w1')
  assert.equal(listExecutors(db)[0].steps, 60)
})

test('add сохраняет модель, права и лимит шагов', () => {
  const db = openDb(':memory:')
  const permissions = parsePermissions({ allow: ['shell:git *'], deny: ['edit:*'] })
  const e = addExecutor(db, {
    id: 'w1',
    kind: 'agent',
    skills: ['backend'],
    model: 'opencode/gpt-5',
    permissions,
    steps: 12,
  })

  assert.equal(e.model, 'opencode/gpt-5')
  assert.equal(e.steps, 12)
  assert.deepEqual(e.permissions, [
    { action: 'shell', resource: 'git *', effect: 'allow' },
    { action: 'edit', resource: '*', effect: 'deny' },
  ])

  const added = lastEvent(db, 'w1')
  assert.equal(added.type, 'executor.added')
  assert.deepEqual(JSON.parse(added.after!), {
    skills: ['backend'],
    kind: 'agent',
    model: 'opencode/gpt-5',
    permissions: e.permissions,
    steps: 12,
  })
})

test('модель без provider/model отвергается', () => {
  const db = openDb(':memory:')

  assert.throws(
    () => addExecutor(db, { id: 'w1', kind: 'agent', skills: ['backend'], model: 'gpt-5' }),
    /provider\/model/,
  )
  assert.equal(getExecutor(db, 'w1'), null)
})

test('лимит шагов проверяется', () => {
  const db = openDb(':memory:')
  addExecutor(db, { id: 'w1', kind: 'agent', skills: ['backend'] })

  assert.throws(() => addExecutor(db, { id: 'w2', kind: 'agent', skills: ['backend'], steps: 0 }), /от 1/)
  assert.throws(() => addExecutor(db, { id: 'w3', kind: 'agent', skills: ['backend'], steps: 2.5 }), /целое/)
  assert.throws(() => setSteps(db, { executorId: 'w1', steps: 'x', actor: 'owner' }), /целое/)
})

test('право без action:resource объясняет формат', () => {
  assert.throws(() => parsePermissions({ allow: ['git *'] }), /action:resource/)
  assert.throws(() => parsePermissions({ deny: ['shell:'] }), /пустой ресурс/)
})

test('позже указанное правило побеждает при том же action:resource', () => {
  const permissions = parsePermissions({ allow: ['shell:git *'], deny: ['shell:git *'] })
  assert.deepEqual(permissions, [{ action: 'shell', resource: 'git *', effect: 'deny' }])
})

test('model меняет значение и пишет событие, inherit очищает', () => {
  const db = openDb(':memory:')
  addExecutor(db, { id: 'w1', kind: 'agent', skills: ['backend'] })

  const updated = setModel(db, { executorId: 'w1', model: 'anthropic/claude-sonnet-4-5', actor: 'owner' })
  assert.equal(updated.model, 'anthropic/claude-sonnet-4-5')

  const changed = lastEvent(db, 'w1')
  assert.equal(changed.type, 'executor.model_changed')
  assert.deepEqual(JSON.parse(changed.before!), { model: null })
  assert.deepEqual(JSON.parse(changed.after!), { model: 'anthropic/claude-sonnet-4-5' })

  const cleared = setModel(db, { executorId: 'w1', model: 'inherit', actor: 'owner' })
  assert.equal(cleared.model, null)
})

test('permissions заменяет правила и пишет событие', () => {
  const db = openDb(':memory:')
  addExecutor(db, { id: 'w1', kind: 'agent', skills: ['backend'] })

  const updated = setPermissions(db, {
    executorId: 'w1',
    permissions: parsePermissions({ allow: ['shell:git *'], deny: ['webfetch:*'] }),
    actor: 'owner',
  })

  assert.deepEqual(updated.permissions, [
    { action: 'shell', resource: 'git *', effect: 'allow' },
    { action: 'webfetch', resource: '*', effect: 'deny' },
  ])

  const changed = lastEvent(db, 'w1')
  assert.equal(changed.type, 'executor.permissions_changed')
  assert.deepEqual(JSON.parse(changed.before!), { permissions: [] })
  assert.deepEqual(JSON.parse(changed.after!), { permissions: updated.permissions })
})

test('steps меняет лимит и пишет событие', () => {
  const db = openDb(':memory:')
  addExecutor(db, { id: 'w1', kind: 'agent', skills: ['backend'] })

  const updated = setSteps(db, { executorId: 'w1', steps: 7, actor: 'owner' })
  assert.equal(updated.steps, 7)

  const changed = lastEvent(db, 'w1')
  assert.equal(changed.type, 'executor.steps_changed')
  assert.deepEqual(JSON.parse(changed.before!), { steps: DEFAULT_STEPS })
  assert.deepEqual(JSON.parse(changed.after!), { steps: 7 })
})

test('busy пишет причину и срок, free снимает занятость', () => {
  const db = openDb(':memory:')
  addExecutor(db, { id: 'w1', kind: 'agent', skills: ['backend'] })

  const busy = setBusy(db, { executorId: 'w1', reason: 'разбор F41', until: '30m', actor: 'w1' })
  assert.equal(busy.reason, 'разбор F41')
  assert.ok(Date.parse(busy.until) > Date.now())
  assert.deepEqual(busyOf(db, 'w1'), busy)

  const event = lastEvent(db, 'w1')
  assert.equal(event.type, 'executor.busy')
  assert.equal(event.note, 'разбор F41')
  assert.deepEqual(JSON.parse(event.after!), { reason: 'разбор F41', until: busy.until })

  const freed = clearBusy(db, { executorId: 'w1', actor: 'owner' })
  assert.equal(freed?.reason, 'разбор F41')
  assert.equal(busyOf(db, 'w1'), null)
  assert.equal(lastEvent(db, 'w1').type, 'executor.free')
})

test('free у свободного исполнителя ничего не пишет', () => {
  const db = openDb(':memory:')
  addExecutor(db, { id: 'w1', kind: 'agent', skills: ['backend'] })
  const before = listEvents(db, { subject: 'w1' }).length

  assert.equal(clearBusy(db, { executorId: 'w1', actor: 'owner' }), null)
  assert.equal(listEvents(db, { subject: 'w1' }).length, before)
  assert.equal(busyOf(db, 'w1'), null)
})

test('истёкшая занятость перестаёт считаться сама', () => {
  const db = openDb(':memory:')
  addExecutor(db, { id: 'w1', kind: 'agent', skills: ['backend'] })
  const busy = setBusy(db, { executorId: 'w1', reason: 'план F41', until: '10m', actor: 'w1' })

  // срок наступил — занятости нет, без фоновых процессов и без записи в журнал
  assert.equal(busyOf(db, 'w1', busy.until), null)
  assert.equal(busyOf(db, 'w1', new Date(Date.parse(busy.until) + 1_000).toISOString()), null)
  assert.ok(busyOf(db, 'w1', busy.since))
  assert.equal(lastEvent(db, 'w1').type, 'executor.busy')
})

test('busy требует причину и срок в будущем', () => {
  const db = openDb(':memory:')
  addExecutor(db, { id: 'w1', kind: 'agent', skills: ['backend'] })

  assert.throws(
    () => setBusy(db, { executorId: 'w1', reason: '  ', until: '30m', actor: 'w1' }),
    /причина/,
  )
  assert.throws(
    () => setBusy(db, { executorId: 'w1', reason: 'разбор', until: '', actor: 'w1' }),
    /срок/,
  )
  assert.throws(
    () =>
      setBusy(db, { executorId: 'w1', reason: 'разбор', until: 'скоро', actor: 'w1' }),
    /формат/,
  )
  assert.throws(
    () =>
      setBusy(db, {
        executorId: 'w1',
        reason: 'разбор',
        until: '2020-01-01T00:00:00.000Z',
        actor: 'w1',
      }),
    /прошёл/,
  )
  assert.throws(
    () => setBusy(db, { executorId: 'nobody', reason: 'разбор', until: '30m', actor: 'w1' }),
    /не найден/,
  )
  assert.equal(busyOf(db, 'w1'), null)
})

test('срок занятости понимает 30m, 2h, 1d и ISO', () => {
  const now = new Date('2026-11-17T10:00:00.000Z')
  assert.equal(parseBusyUntil('30m', now), '2026-11-17T10:30:00.000Z')
  assert.equal(parseBusyUntil('2h', now), '2026-11-17T12:00:00.000Z')
  assert.equal(parseBusyUntil('1d', now), '2026-11-18T10:00:00.000Z')
  assert.equal(parseBusyUntil('2026-11-17T12:00:00.000Z', now), '2026-11-17T12:00:00.000Z')
})


