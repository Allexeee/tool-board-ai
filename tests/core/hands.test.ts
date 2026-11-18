import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { openDb, type DatabaseSync } from '../../src/core/db.ts'
import { addRequest } from '../../src/core/requests.ts'
import { abandonFeature, addFeature, setFeatureBranch } from '../../src/core/features.ts'
import { addStage, activateNextStage } from '../../src/core/stages.ts'
import { createTask, updateTask } from '../../src/core/tasks.ts'
import { refreshReady, addDep } from '../../src/core/deps.ts'
import { advanceTime } from '../../src/core/clock.ts'
import { takeTask } from '../../src/core/lease.ts'
import { addExecutor } from '../../src/core/executors.ts'
import { clearHand, compareTasks, dispatchHands, fillHand, getHand, refillHands, setHand } from '../../src/core/hands.ts'
import { countAssignments, dispatchPlan } from '../../src/core/views.ts'
import { startRun } from '../../src/core/runs.ts'
import { listEvents } from '../../src/core/events.ts'

const plusMinutes = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString()

function seed(db: DatabaseSync): string {
  addExecutor(db, { id: 'w1', kind: 'agent', skills: ['backend'] })
  addExecutor(db, { id: 'w2', kind: 'agent', skills: ['backend'] })

  const request = addRequest(db, { title: 'Оплата', body: '...', author: 'owner' })
  const feature = addFeature(db, { requestId: request.id, name: 'A', rank: 1 })
  setFeatureBranch(db, feature.id, 'feat/test', 'C:/tmp/test-worktree')
  const stage = addStage(db, { featureId: feature.id, name: 'S1', goal: 'g', appetite: '2 дня' })
  activateNextStage(db, feature.id)

  const base = {
    stageId: stage.id,
    dod: ['a'],
    size: 'S' as const,
    skill: 'backend',
    class: 'standard' as const,
    scope: ['src/**'],
  }
  createTask(db, { ...base, title: 'Первый шаг' })
  createTask(db, { ...base, title: 'Второй шаг' })
  createTask(db, { ...base, title: 'Третий шаг' })
  refreshReady(db)
  return stage.id
}

interface Assigned {
  executor: string
  task: string
  source: string
}

/** Выдачи из журнала: одно событие — одна выдача, по нему видно источник. */
function assignedOf(db: DatabaseSync): Assigned[] {
  return listEvents(db)
    .filter((event) => event.type === 'hand.assigned')
    .map((event) => JSON.parse(event.after!) as Assigned)
}

/** Ещё одна фича со своим активным этапом и задачами: у неё свой рабочий каталог. */
function addStageWithTasks(db: DatabaseSync, rank: number, count: number): string {
  const feature = addFeature(db, { name: `Фича ${rank}`, rank })
  setFeatureBranch(db, feature.id, `feat/test-${rank}`, `C:/tmp/test-worktree-${rank}`)
  const stage = addStage(db, { featureId: feature.id, name: 'S1', goal: 'g', appetite: '2 дня' })
  activateNextStage(db, feature.id)

  for (let index = 1; index <= count; index += 1) {
    createTask(db, {
      stageId: stage.id,
      title: `Шаг ${index}`,
      dod: ['a'],
      size: 'S',
      skill: 'backend',
      class: 'standard',
      scope: [`src/${rank}/${index}/**`],
    })
  }
  refreshReady(db)
  return stage.id
}

test('рука пополняется задачами того же этапа первыми', () => {
  const db = openDb(':memory:')
  const stageId = seed(db)
  const hand = fillHand(db, 'w1')
  assert.equal(hand[0].id, `${stageId}-1`)
})

test('все кандидаты заблокированы — рука пуста, без зависания', () => {
  const db = openDb(':memory:')
  seed(db)
  db.prepare("update tasks set status='blocked'").run()
  assert.deepEqual(fillHand(db, 'w1'), [])
})

test('порядок: expedite раньше standard, XS раньше M', () => {
  const make = (over: Record<string, unknown>) => ({ id: 'x', class: 'standard', size: 'S', ...over }) as never
  assert.ok(compareTasks(make({ class: 'expedite', size: 'M' }), make({ size: 'XS' })) < 0)
  assert.ok(compareTasks(make({ size: 'XS' }), make({ size: 'M' })) < 0)
})

test('задача с чужим навыком не попадает в руку', () => {
  const db = openDb(':memory:')
  const stageId = seed(db)
  createTask(db, {
    stageId,
    title: 'Записать выстрелы',
    dod: ['a'],
    size: 'S',
    skill: 'audio',
    class: 'standard',
    scope: ['assets/**'],
  })
  refreshReady(db)
  assert.equal(fillHand(db, 'w1').some((task) => task.skill === 'audio'), false)
})

test('чужой резерв не мешает взять задачу', () => {
  const db = openDb(':memory:')
  const stageId = seed(db)
  fillHand(db, 'w1')

  const task = takeTask(db, { executor: 'w2', taskId: `${stageId}-1` })

  assert.equal(task.holder, 'w2')
  assert.deepEqual(
    getHand(db, 'w2').map((item) => item.id).includes(`${stageId}-1`),
    false,
    'резерв снят при взятии',
  )
})

test('take без id берёт одну задачу и не запасает руку', () => {
  const db = openDb(':memory:')
  const stageId = seed(db)

  const task = takeTask(db, { executor: 'w1' })

  assert.equal(task.id, `${stageId}-1`)
  assert.deepEqual(getHand(db, 'w1'), [])
  const ready = db
    .prepare("select count(*) as c from tasks where stage_id = ? and status = 'ready'")
    .get(stageId) as { c: number }
  assert.equal(ready.c, 2, 'остальные задачи остаются свободными')
})

test('take без id уважает порядок своей руки', () => {
  const db = openDb(':memory:')
  const stageId = seed(db)
  setHand(db, 'w1', [`${stageId}-3`, `${stageId}-2`], 'owner')

  const task = takeTask(db, { executor: 'w1' })

  assert.equal(task.id, `${stageId}-3`)
  assert.deepEqual(
    getHand(db, 'w1').map((item) => item.id),
    [`${stageId}-2`],
  )
})

test('исполнитель offline теряет руку', () => {
  const db = openDb(':memory:')
  seed(db)
  fillHand(db, 'w2')
  assert.ok(getHand(db, 'w2').length > 0)
  advanceTime(db, plusMinutes(121))
  assert.deepEqual(getHand(db, 'w2'), [])
})

test('setHand не отбирает задачу, зарезервированную другим', () => {
  const db = openDb(':memory:')
  const stageId = seed(db)
  fillHand(db, 'w1')
  assert.throws(() => setHand(db, 'w2', [`${stageId}-1`], 'orchestrator'), /зарезервирован/)
})

test('setHand не падает, если задача в списке повторяется', () => {
  const db = openDb(':memory:')
  const stageId = seed(db)
  const hand = setHand(db, 'w1', [`${stageId}-1`, `${stageId}-1`], 'orchestrator')
  assert.deepEqual(hand.map((task) => task.id), [`${stageId}-1`])
})

test('setHand принимает шаг, чья зависимость уже лежит в руке', () => {
  const db = openDb(':memory:')
  const stageId = seed(db)
  addDep(db, `${stageId}-2`, `${stageId}-1`)
  refreshReady(db)

  const hand = setHand(db, 'w1', [`${stageId}-1`, `${stageId}-2`], 'owner')

  assert.deepEqual(hand.map((task) => task.id), [`${stageId}-1`, `${stageId}-2`])
  assert.equal(hand[1].status, 'open', 'следующий шаг виден в руке до своей готовности')
})

test('setHand принимает шаг с уже закрытой зависимостью', () => {
  const db = openDb(':memory:')
  const stageId = seed(db)
  addDep(db, `${stageId}-2`, `${stageId}-1`)
  db.prepare("update tasks set status = 'done' where id = ?").run(`${stageId}-1`)
  refreshReady(db)

  const hand = setHand(db, 'w1', [`${stageId}-2`], 'owner')

  assert.deepEqual(hand.map((task) => task.id), [`${stageId}-2`])
})

test('setHand отказывает, если зависимость не закрыта и её нет в руке', () => {
  const db = openDb(':memory:')
  const stageId = seed(db)
  addDep(db, `${stageId}-2`, `${stageId}-1`)
  refreshReady(db)

  assert.throws(
    () => setHand(db, 'w1', [`${stageId}-2`], 'owner'),
    (error: Error) => error.message.includes('ждёт зависимость') && error.message.includes(`${stageId}-1`),
    'в тексте отказа названа мешающая зависимость',
  )
})

test('setHand обрезает цепочку по размеру руки', () => {
  const db = openDb(':memory:')
  const stageId = seed(db)
  addExecutor(db, { id: 'w3', kind: 'agent', skills: ['backend'], handSize: 2 })

  const hand = setHand(db, 'w3', [`${stageId}-1`, `${stageId}-2`, `${stageId}-3`], 'owner')

  assert.deepEqual(hand.map((task) => task.id), [`${stageId}-1`, `${stageId}-2`])
})

test('пул набирается после блока фичи', () => {
  const db = openDb(':memory:')
  const stageId = seed(db)

  createTask(db, {
    title: 'Поправить опечатку',
    dod: ['опечатки нет'],
    size: 'XS',
    skill: 'backend',
    class: 'quick',
    scope: ['docs/**'],
  })
  refreshReady(db)

  const hand = fillHand(db, 'w1')
  assert.equal(hand[0].id, `${stageId}-1`)
  assert.ok(hand.some((task) => task.id === 'T1'), 'задача пула попала в руку')
  assert.equal(hand[hand.length - 1].id, 'T1')
})

test('задача, ушедшая из ready, исчезает из руки', () => {
  const db = openDb(':memory:')
  const stageId = seed(db)
  fillHand(db, 'w1')
  assert.ok(getHand(db, 'w1').length > 0)

  updateTask(db, `${stageId}-1`, { status: 'blocked', reason: 'needs_data' })

  assert.equal(getHand(db, 'w1').some((task) => task.id === `${stageId}-1`), false)
})

test('abandon фичи чистит руку', () => {
  const db = openDb(':memory:')
  seed(db)
  fillHand(db, 'w1')
  assert.ok(getHand(db, 'w1').length > 0)

  const feature = db.prepare('select id from features').get() as { id: string }
  abandonFeature(db, { featureId: feature.id, actor: 'owner', reason: 'передумали' })

  assert.deepEqual(getHand(db, 'w1'), [])
})

test('задачи одного этапа не делят между свободными исполнителями', () => {
  const db = openDb(':memory:')
  const stageId = seed(db)

  const plan = dispatchPlan(db)
  const w1 = plan.assignments.find((entry) => entry.executor === 'w1')!.tasks
  const w2 = plan.assignments.find((entry) => entry.executor === 'w2')!.tasks

  const spread = [...w1, ...w2]
  assert.deepEqual([...spread].sort(), [`${stageId}-1`, `${stageId}-2`, `${stageId}-3`])
  assert.equal(new Set(spread).size, spread.length, 'одна задача — одной руке')
  assert.ok(
    (w1.length === 3 && w2.length === 0) || (w1.length === 0 && w2.length === 3),
    'этап целиком ушёл одной руке: вторая в тот же каталог не лезет',
  )
})

test('каждый этап целиком уходит одной руке: два этапа — две руки', () => {
  const db = openDb(':memory:')
  const first = seed(db)
  const second = addStageWithTasks(db, 2, 2)
  const firstTasks = [1, 2, 3].map((n) => `${first}-${n}`)
  const secondTasks = [1, 2].map((n) => `${second}-${n}`)

  dispatchHands(db)

  const handOf = (executor: string) => getHand(db, executor).map((task) => task.id)
  const holdersOf = (taskIds: string[]) =>
    ['w1', 'w2'].filter((executor) => handOf(executor).some((id) => taskIds.includes(id)))

  assert.equal(holdersOf(firstTasks).length, 1, 'первый этап не разошёлся по рукам')
  assert.equal(holdersOf(secondTasks).length, 1, 'второй этап не разошёлся по рукам')
  assert.notDeepEqual(holdersOf(firstTasks), holdersOf(secondTasks), 'этапы разошлись по разным рукам')
  assert.deepEqual([...handOf('w1'), ...handOf('w2')].sort(), [...firstTasks, ...secondTasks].sort())
})

test('этап, который уже в работе, добирает тот же исполнитель', () => {
  const db = openDb(':memory:')
  const stageId = seed(db)
  takeTask(db, { executor: 'w1', taskId: `${stageId}-2` })

  dispatchHands(db)

  assert.deepEqual(
    getHand(db, 'w1').map((task) => task.id),
    [`${stageId}-1`, `${stageId}-3`],
    'остаток этапа ушёл тому, кто его уже делает',
  )
  assert.deepEqual(getHand(db, 'w2'), [], 'другая рука в тот же каталог не лезет')
})

test('после слияния этапа ограничение снимается: следующий этап уходит другой руке', () => {
  const db = openDb(':memory:')
  const stageId = seed(db)
  dispatchHands(db)
  assert.equal(getHand(db, 'w1').length, 3, 'первый этап целиком у w1')

  // этап слит: задачи закрыты, неслитых задач у него больше нет
  db.prepare("update tasks set status = 'done' where stage_id = ?").run(stageId)
  db.prepare("update stages set status = 'merged', merged_at = ? where id = ?").run(
    new Date().toISOString(),
    stageId,
  )

  const feature = db.prepare('select id from features').get() as { id: string }
  const next = addStage(db, { featureId: feature.id, name: 'S2', goal: 'g', appetite: '2 дня' })
  activateNextStage(db, feature.id)
  for (const title of ['Четвёртый шаг', 'Пятый шаг']) {
    createTask(db, {
      stageId: next.id,
      title,
      dod: ['a'],
      size: 'S',
      skill: 'backend',
      class: 'standard',
      scope: ['src/**'],
    })
  }
  refreshReady(db)

  // прежний держатель этапа занят: места в руке нет
  db.prepare("update executors set hand_size = 0 where id = 'w1'").run()
  dispatchHands(db)

  assert.deepEqual(
    getHand(db, 'w2').map((task) => task.id),
    [`${next.id}-1`, `${next.id}-2`],
    'новый этап не привязан к руке, державшей предыдущий',
  )
  assert.deepEqual(getHand(db, 'w1'), [])
})

test('dispatch кладёт в руку задачу и её зависимые шаги', () => {
  const db = openDb(':memory:')
  const stageId = seed(db)
  addDep(db, `${stageId}-2`, `${stageId}-1`)
  addDep(db, `${stageId}-3`, `${stageId}-2`)
  refreshReady(db)

  const plan = dispatchPlan(db)
  const w1 = plan.assignments.find((entry) => entry.executor === 'w1')!.tasks
  const w2 = plan.assignments.find((entry) => entry.executor === 'w2')!.tasks

  assert.deepEqual(w1, [`${stageId}-1`, `${stageId}-2`, `${stageId}-3`], 'шаги едут следом за задачей')
  assert.deepEqual(w2, [], 'цепочку не рвут между исполнителями')
})

test('цепочка в руке обрывается на её размере', () => {
  const db = openDb(':memory:')
  const stageId = seed(db)
  addDep(db, `${stageId}-2`, `${stageId}-1`)
  addDep(db, `${stageId}-3`, `${stageId}-2`)
  refreshReady(db)
  db.prepare("update executors set hand_size = 2 where id = 'w1'").run()

  const plan = dispatchPlan(db)
  const w1 = plan.assignments.find((entry) => entry.executor === 'w1')!.tasks
  const w2 = plan.assignments.find((entry) => entry.executor === 'w2')!.tasks

  assert.deepEqual(w1, [`${stageId}-1`, `${stageId}-2`])
  assert.deepEqual(w2, [], 'шаг не отдают чужой руке в отрыве от цепочки')
})

test('каждая выдача оставляет hand.assigned со своим источником', () => {
  const db = openDb(':memory:')
  const stageId = seed(db)
  const [first, second, third] = [1, 2, 3].map((n) => `${stageId}-${n}`)

  // рука выдаёт напрямую — источник hand
  setHand(db, 'w1', [second], 'owner')
  assert.deepEqual(assignedOf(db), [{ executor: 'w1', task: second, source: 'hand' }])

  // раздача раскладывает остаток — источник dispatch; этап целиком одной руке
  dispatchHands(db)
  assert.deepEqual(assignedOf(db).slice(1), [
    { executor: 'w1', task: first, source: 'dispatch' },
    { executor: 'w1', task: third, source: 'dispatch' },
  ])

  // взятие по id задачи, лежавшей в руке, — источник hand
  takeTask(db, { executor: 'w1', taskId: third })

  // взятие по id задачи, которой ни у кого не было — источник take
  const pool = createTask(db, {
    title: 'Поправить опечатку',
    dod: ['опечатки нет'],
    size: 'XS',
    skill: 'backend',
    class: 'quick',
    scope: ['docs/**'],
  })
  refreshReady(db)
  takeTask(db, { executor: 'w2', taskId: pool.id })

  const events = assignedOf(db)
  assert.deepEqual(
    events.map((event) => event.source),
    ['hand', 'dispatch', 'dispatch', 'hand', 'take'],
    'источники различаются: рука, раздача и взятие по id',
  )
  assert.equal(
    events.length,
    5,
    'событий ровно столько, сколько выдач: выдача рукой, две раздачи и два взятия по id',
  )
})

test('повторная выдача не удваивает событие: их ровно по выдачам', () => {
  const db = openDb(':memory:')
  const stageId = seed(db)
  const [first, second] = [1, 2].map((n) => `${stageId}-${n}`)

  setHand(db, 'w1', [first], 'owner')
  setHand(db, 'w1', [first], 'owner')
  assert.deepEqual(assignedOf(db).map((event) => event.task), [first], 'та же рука — не новая выдача')

  setHand(db, 'w1', [first, second], 'owner')
  assert.deepEqual(
    assignedOf(db).map((event) => event.task),
    [first, second],
    'добавленная задача — одна выдача',
  )

  // взятие без id идёт из уже выданной руки: новых выдач нет
  takeTask(db, { executor: 'w1' })
  assert.equal(assignedOf(db).length, 2)
})

test('вне прогона автодобор не наполняет руки', () => {
  const db = openDb(':memory:')
  seed(db)

  const filled = refillHands(db)

  assert.equal(filled, false, 'прогона нет — добирать не для кого')
  assert.deepEqual(getHand(db, 'w1'), [])
  assert.deepEqual(getHand(db, 'w2'), [])
  assert.deepEqual(assignedOf(db), [], 'ни одной выдачи в журнале')
})

test('в прогоне автодобор наполняет руки', () => {
  const db = openDb(':memory:')
  seed(db)
  startRun(db, { mode: 'plan' })

  const filled = refillHands(db)

  assert.equal(filled, true)
  assert.ok(getHand(db, 'w1').length + getHand(db, 'w2').length > 0, 'задачи разошлись по рукам')
})

test('hand clear освобождает руку целиком и пишет событие', () => {
  const db = openDb(':memory:')
  const stageId = seed(db)
  const [first, second] = [1, 2].map((n) => `${stageId}-${n}`)
  setHand(db, 'w1', [first, second], 'owner')

  const freed = clearHand(db, 'w1', 'owner')

  assert.deepEqual(freed, [first, second])
  assert.deepEqual(getHand(db, 'w1'), [])

  const cleared = listEvents(db).filter((event) => event.type === 'hand.cleared')
  assert.equal(cleared.length, 1, 'снятие руки видно в журнале')
  assert.equal(cleared[0]!.subject, 'w1')
  assert.deepEqual(JSON.parse(cleared[0]!.after!), { tasks: freed })

  // снятая задача снова свободна: её можно выдать другой руке
  assert.deepEqual(
    setHand(db, 'w2', [first], 'owner').map((task) => task.id),
    [first],
  )
})

test('dispatch и взятие по id дают счётчики 1/0/1', () => {
  const db = openDb(':memory:')
  addExecutor(db, { id: 'w1', kind: 'agent', skills: ['backend'] })
  addExecutor(db, { id: 'w2', kind: 'agent', skills: ['backend'] })

  const request = addRequest(db, { title: 'Оплата', body: '...', author: 'owner' })
  const feature = addFeature(db, { requestId: request.id, name: 'A', rank: 1 })
  setFeatureBranch(db, feature.id, 'feat/test', 'C:/tmp/test-worktree')
  const stage = addStage(db, { featureId: feature.id, name: 'S1', goal: 'g', appetite: '2 дня' })
  activateNextStage(db, feature.id)
  createTask(db, {
    stageId: stage.id,
    title: 'Первый шаг',
    dod: ['a'],
    size: 'S',
    skill: 'backend',
    class: 'standard',
    scope: ['src/**'],
  })
  refreshReady(db)

  // раздача выдала единственную задачу этапа
  dispatchHands(db)
  assert.deepEqual(countAssignments(db), { dispatch: 1, hand: 0, take: 0 })

  // задачу, которой ни у кого не было, берут по id: это взятие, а не выдача руками
  const pool = createTask(db, {
    title: 'Поправить опечатку',
    dod: ['опечатки нет'],
    size: 'XS',
    skill: 'backend',
    class: 'quick',
    scope: ['docs/**'],
  })
  refreshReady(db)
  takeTask(db, { executor: 'w2', taskId: pool.id })

  assert.deepEqual(countAssignments(db), { dispatch: 1, hand: 0, take: 1 })
})

const bin = resolve('bin/toolbox-al.ts')
const taskFlags = ['--dod', 'шаг сделан', '--size', 'XS', '--skill', 'backend', '--scope', 'src/**']

function spawnCli(dir: string, args: string[]) {
  const result = spawnSync(process.execPath, [bin, ...args], { cwd: dir, encoding: 'utf8' })
  return { code: result.status, out: result.stdout ?? '', err: result.stderr ?? '' }
}

function gitIn(dir: string, args: string[], env?: NodeJS.ProcessEnv) {
  execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env })
}

/** Проект на ветке dev, где done коммитит в корне: рука из T1 и T2, свободная T3. */
function cliRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'al-hands-'))
  gitIn(dir, ['init', '-q'])
  gitIn(dir, ['config', 'user.email', 't@e.x'])
  gitIn(dir, ['config', 'user.name', 'T'])
  writeFileSync(join(dir, 'README.md'), 'x')
  gitIn(dir, ['add', '.'])
  gitIn(dir, ['commit', '-q', '-m', 'init'])
  gitIn(dir, ['checkout', '-q', '-b', 'dev'])

  spawnCli(dir, ['init'])
  spawnCli(dir, ['executor', 'add', 'w1', '--skills', 'backend'])
  gitIn(dir, ['add', '.'])
  // dev защищён хуком init: настройка проекта — не задача, разрешаем явно
  gitIn(dir, ['commit', '-q', '-m', 'setup'], { ...process.env, AL_ALLOW: '1' })

  for (const title of ['Первый шаг', 'Второй шаг', 'Третий шаг']) {
    const added = spawnCli(dir, ['task', 'add', title, ...taskFlags])
    assert.equal(added.code, 0, added.err)
  }

  const hand = spawnCli(dir, ['hand', 'set', 'T1', 'T2', '--as', 'w1'])
  assert.equal(hand.code, 0, hand.err)
  return dir
}

test('done вне прогона не добирает руку', () => {
  const dir = cliRepo()

  const taken = spawnCli(dir, ['take', 'T1', '--as', 'w1'])
  assert.equal(taken.code, 0, taken.err)

  mkdirSync(join(dir, 'src'), { recursive: true })
  writeFileSync(join(dir, 'src/a.ts'), 'a')
  const closed = spawnCli(dir, ['done', 'T1', '--as', 'w1', '--summary', 'шаг сделан'])
  assert.equal(closed.code, 0, closed.err)

  const shown = spawnCli(dir, ['hand', 'show', '--as', 'w1'])
  assert.equal(shown.code, 0, shown.err)
  assert.match(shown.out, /T2/, 'оставшаяся задача руки на месте')
  assert.doesNotMatch(shown.out, /T3/, 'вне прогона свободная задача в руку не попала')
})

test('hand clear освобождает руку исполнителя', () => {
  const dir = cliRepo()

  const cleared = spawnCli(dir, ['hand', 'clear', '--as', 'w1'])
  assert.equal(cleared.code, 0, cleared.err)
  assert.match(cleared.out, /рука освобождена: T1, T2/)

  const shown = spawnCli(dir, ['hand', 'show', '--as', 'w1'])
  assert.equal(shown.code, 0, shown.err)
  assert.match(shown.out, /рука пуста/)
})



