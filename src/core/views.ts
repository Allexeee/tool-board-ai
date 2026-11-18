import type { DatabaseSync } from 'node:sqlite'
import { advanceTime } from './clock.ts'
import { listFeatures } from './features.ts'
import { listStages, type StageStatus } from './stages.ts'
import { busyOf, listExecutors } from './executors.ts'
import { listTasks, type TaskStatus } from './tasks.ts'
import { depsOf, isSatisfied } from './deps.ts'
import { getHand, dispatchHands, nextTask, stageOwner, type AssignSource } from './hands.ts'
import { activeRun, lastClosedRun } from './runs.ts'
import { listDecisions } from './decisions.ts'
import { openRequests } from './requests.ts'
import type { LiveSession } from './usage.ts'
import { pendingRelease } from './git/release.ts'

export interface QueueRow {
  taskId: string
  title: string
  status: TaskStatus
  featureId: string | null
  stageId: string | null
  /** чего ждёт: незакрытые зависимости */
  waitsFor: string[]
  /** кому назначена: держатель или исполнитель, в чьей руке лежит */
  holder: string | null
  hand: string | null
  /** почему задачу никто не взял; null — задача уже назначена */
  reason: string | null
}

/** Причина у задачи, которой ничто не мешает: не хватает только раздачи. */
export const queueFreeReason = 'ждёт раздачи'

interface QueueSort {
  rank: number
  seq: number
  depth: number
  id: string
}

/** Прежний порядок: ранг фичи, номер этапа, глубина по зависимостям, номер задачи. */
function compareQueue(a: QueueSort, b: QueueSort): number {
  return a.rank - b.rank || a.seq - b.seq || a.depth - b.depth || a.id.localeCompare(b.id)
}

/** Откуда задача попала в руку: раздачей, прямой рукой или взятием по id. */
export interface AssignCounts {
  dispatch: number
  hand: number
  take: number
}

export interface AssignStats {
  /** За всё время. */
  total: AssignCounts
  /** За текущий прогон: активный, иначе последний закрытый; null — прогонов не было. */
  run: AssignCounts | null
}

const ASSIGN_SOURCES: AssignSource[] = ['dispatch', 'hand', 'take']

/**
 * Счётчики выдачи по журналу hand.assigned, а не по резервам: владелец видит,
 * сколько задач выдала раздача, сколько выдано руками и сколько взято без выдачи.
 */
export function countAssignments(
  db: DatabaseSync,
  period: { since?: string; until?: string } = {},
): AssignCounts {
  const where = ["type = 'hand.assigned'"]
  const params: string[] = []
  if (period.since) {
    where.push('at >= ?')
    params.push(period.since)
  }
  if (period.until) {
    where.push('at <= ?')
    params.push(period.until)
  }

  const rows = db
    .prepare(`select after from events where ${where.join(' and ')}`)
    .all(...params) as Array<{ after: string | null }>

  const counts: AssignCounts = { dispatch: 0, hand: 0, take: 0 }
  for (const row of rows) {
    if (!row.after) continue

    let source: string
    try {
      source = String((JSON.parse(row.after) as { source?: unknown }).source ?? '')
    } catch {
      continue
    }

    if (ASSIGN_SOURCES.includes(source as AssignSource)) counts[source as AssignSource] += 1
  }

  return counts
}

/** За всё время и за текущий прогон: второй срез владельцу важнее — он про последнюю работу. */
export function assignmentStats(db: DatabaseSync): AssignStats {
  const run = activeRun(db) ?? lastClosedRun(db)

  return {
    total: countAssignments(db),
    run: run ? countAssignments(db, { since: run.startedAt, until: run.endedAt ?? undefined }) : null,
  }
}

/**
 * Порядок с уважением к зависимостям: блокер всегда выше зависимой задачи,
 * даже если у той лучше ранг фичи или меньше номер этапа. Среди свободных
 * решает прежний порядок, поэтому внутри одного этапа всё как раньше.
 *
 * Цикл сюда не доходит — addDep его отвергает; но если он уже лежит в базе,
 * остаток добираем прежним порядком, а не теряем задачи молча.
 */
function orderByDeps(
  ids: string[],
  blockersOf: (id: string) => string[],
  keyOf: (id: string) => QueueSort,
): string[] {
  const inside = new Set(ids)
  const waiting = new Map<string, Set<string>>()

  for (const id of ids) {
    // задачи вне очереди (закрытые, отложенные) блокером не считаются: их порядок не наш
    waiting.set(
      id,
      new Set(blockersOf(id).filter((blocker) => blocker !== id && inside.has(blocker))),
    )
  }

  const compare = (a: string, b: string) => compareQueue(keyOf(a), keyOf(b))
  const ready = ids.filter((id) => waiting.get(id)!.size === 0)
  const ordered: string[] = []

  while (ready.length > 0) {
    ready.sort(compare)
    const next = ready.shift()!
    ordered.push(next)
    waiting.delete(next)

    for (const [id, blockers] of waiting) {
      if (blockers.delete(next) && blockers.size === 0) ready.push(id)
    }
  }

  if (ordered.length < ids.length) {
    const placed = new Set(ordered)
    ordered.push(...ids.filter((id) => !placed.has(id)).sort(compare))
  }

  return ordered
}

/**
 * Порядок, в котором задачи будут взяты: зависимости держат блокер выше
 * зависимой, среди свободных — ранг фичи, номер этапа, глубина, номер задачи.
 * Владельцу нужен порядок, а не разбивка по рукам.
 */
export function taskQueue(db: DatabaseSync): QueueRow[] {
  advanceTime(db)

  const features = listFeatures(db)
  const rankOf = new Map(features.map((feature) => [feature.id, feature.rank]))
  const featureOf = new Map(features.map((feature) => [feature.id, feature]))
  const seqOf = new Map<string, { featureId: string; seq: number; status: StageStatus }>()
  for (const feature of features) {
    for (const stage of listStages(db, feature.id)) {
      seqOf.set(stage.id, { featureId: feature.id, seq: stage.seq, status: stage.status })
    }
  }

  const tasks = listTasks(db).filter(
    (task) => task.status !== 'done' && task.status !== 'cancelled' && task.status !== 'deferred',
  )

  const depth = new Map<string, number>()
  const byId = new Map(tasks.map((task) => [task.id, task]))
  const depthOf = (id: string, seen = new Set<string>()): number => {
    if (depth.has(id)) return depth.get(id)!
    if (seen.has(id)) return 0
    seen.add(id)

    // глубина — по зависимостям: блокер считается первым, зависимая идёт ниже
    const blockers = depsOf(db, id).filter((blocker) => byId.has(blocker))

    const value = blockers.length === 0 ? 0 : Math.max(...blockers.map((blocker) => depthOf(blocker, seen) + 1))
    depth.set(id, value)
    return value
  }

  const hand = db.prepare('select task_id, executor_id from hand').all() as Array<{
    task_id: string
    executor_id: string
  }>
  const handOf = new Map(hand.map((row) => [row.task_id, row.executor_id]))

  // занятость для раздачи: держит задачу или рука полна — брать некуда.
  const executors = listExecutors(db)
  const handLoad = new Map<string, number>()
  for (const row of hand) {
    // рука считается по тем же задачам, что видит getHand: закрытая задача место не держит.
    const held = byId.get(row.task_id)
    if (!held || (held.status !== 'ready' && held.status !== 'open')) continue
    handLoad.set(row.executor_id, (handLoad.get(row.executor_id) ?? 0) + 1)
  }
  const hasWork = new Set(
    (db.prepare("select distinct holder as id from tasks where status = 'active' and holder is not null").all() as Array<{
      id: string
    }>).map((row) => row.id),
  )
  const isBusy = (executorId: string, handSize: number): boolean =>
    hasWork.has(executorId) || (handLoad.get(executorId) ?? 0) >= handSize

  const rows = new Map<string, QueueRow>()
  const sort = new Map<string, QueueSort>()

  for (const task of tasks) {
    const place = task.stageId ? seqOf.get(task.stageId) : undefined
    const featureId = place?.featureId ?? null
    const waitsFor = depsOf(db, task.id).filter((dep) => !isSatisfied(db, dep))

    // назначенная задача никого не ждёт: причина есть только у свободной.
    const reason =
      task.holder !== null || handOf.has(task.id)
        ? null
        : reasonOf({
            task,
            place,
            waitsFor,
            feature: featureId ? featureOf.get(featureId) : undefined,
            executors,
            isBusy,
            stageOwner: task.stageId ? stageOwner(db, task.stageId) : null,
          })

    rows.set(task.id, {
      taskId: task.id,
      title: task.title,
      status: task.status,
      featureId,
      stageId: task.stageId,
      waitsFor,
      holder: task.holder,
      hand: handOf.get(task.id) ?? null,
      reason,
    })
    sort.set(task.id, {
      rank: featureId ? (rankOf.get(featureId) ?? 99) : 999,
      seq: place?.seq ?? 999,
      depth: depthOf(task.id),
      id: task.id,
    })
  }

  const order = orderByDeps(
    tasks.map((task) => task.id),
    (id) => depsOf(db, id),
    (id) => sort.get(id)!,
  )

  return order.map((id) => rows.get(id)!)
}

/**
 * Порядок проверок — от того, что можно исправить, к тому, что просто ждёт:
 * зависимость, статус, этап, каталог, навык, занятость. Всё остальное — недораздача.
 *
 * Этап, у которого есть владелец, решается по нему, а не глухим «этап у X»:
 * владелец без навыка — это тупик «нет исполнителя», свободный владелец —
 * «ждёт раздачи», и только занятый даёт «этап у X».
 */
function reasonOf(input: {
  task: { status: TaskStatus; stageId: string | null; skill: string }
  place: { status: StageStatus } | undefined
  waitsFor: string[]
  feature: { worktree: string | null } | undefined
  executors: Array<{ id: string; skills: string[]; handSize: number }>
  isBusy: (executorId: string, handSize: number) => boolean
  stageOwner?: string | null
}): string {
  const { task, place, waitsFor, feature, executors, isBusy } = input

  if (waitsFor.length > 0) return `ждёт ${waitsFor.join(', ')}`

  if (task.status !== 'ready') {
    // refreshReady превращает задачи неактивного этапа в planned:
    // владельцу важна причина «этап не активен», а не название статуса.
    if (task.status === 'planned' && task.stageId !== null && place?.status !== 'active') {
      return 'этап не активен'
    }
    return `не готова: ${task.status}`
  }

  if (task.stageId !== null) {
    if (!place || place.status !== 'active') return 'этап не активен'
    if (!feature || feature.worktree === null) return 'нет каталога фичи'
    // этап живёт в одном каталоге: пока его держит другая рука, раздача сюда не пойдёт.
    // Но «этап у X» — не всегда настоящая помеха: у X может не быть навыка задачи
    // (тогда тупик — «нет исполнителя»), а может быть и свободная рука (тогда ждёт раздачи).
    if (input.stageOwner) {
      const owner = executors.find((executor) => executor.id === input.stageOwner)
      if (!owner || !owner.skills.includes(task.skill)) return `нет исполнителя: ${task.skill}`
      if (isBusy(owner.id, owner.handSize)) return `этап у ${input.stageOwner}`
      return queueFreeReason
    }
  }

  const skilled = executors.filter((executor) => executor.skills.includes(task.skill))
  if (skilled.length === 0) return `нет исполнителя: ${task.skill}`
  if (skilled.every((executor) => isBusy(executor.id, executor.handSize))) return 'исполнители заняты'

  return queueFreeReason
}

export interface NowView {
  features: Array<{
    id: string
    name: string
    rank: number
    status: string
    finished: boolean
    stage: { id: string; seq: number; total: number; done: number; counts: Record<string, number> }
  }>
  pool: Array<{ id: string; title: string }>
  holders: Array<{
    executor: string
    task: string | null
    active: string[]
    hand: string[]
    session: string | null
    /** занятость без задачи: причина и срок; null — свободен */
    busy: { reason: string; until: string } | null
    /** есть работа: держит задачу, имеет руку или (для worker-0) идёт прогон */
    working: boolean
  }>
  requests: Array<{ id: string; title: string }>
  plans: Array<{ id: string; requestId: string; title: string }>
  /** Фичи, у которых все этапы слиты в dev и ещё не выпущены: они ждут main. */
  waitingMain: Array<{ id: string; name: string }>
  /** Живые субагенты сессии: дочерние сессии OpenCode за последнее окно. */
  sessions: LiveSession[]
  unreleased: number
  /** Как выдавались задачи: раздачей, руками, взятием без выдачи. */
  assignment: AssignStats
}

/**
 * Фичи, которые ждут main: все этапы слиты в dev, но ни один не попал в релиз.
 * Свежие сверху — по времени последнего слияния этапа.
 */
function waitingMainFeatures(db: DatabaseSync): Array<{ id: string; name: string }> {
  const pending = pendingRelease(db)
  if (pending.length === 0) return []

  const totals = new Map(
    (
      db.prepare('select feature_id as id, count(*) as total from stages group by feature_id').all() as Array<{
        id: string
        total: number
      }>
    ).map((row) => [row.id, row.total]),
  )

  const byFeature = new Map<string, { name: string; stages: number; fresh: string }>()
  for (const stage of pending) {
    const entry = byFeature.get(stage.featureId) ?? { name: stage.featureName, stages: 0, fresh: '' }
    entry.stages += 1
    const mergedAt = stage.mergedAt ?? ''
    if (mergedAt > entry.fresh) entry.fresh = mergedAt
    byFeature.set(stage.featureId, entry)
  }

  return [...byFeature.entries()]
    .filter(([id, entry]) => entry.stages === totals.get(id))
    .sort((a, b) => b[1].fresh.localeCompare(a[1].fresh) || a[0].localeCompare(b[0]))
    .map(([id, entry]) => ({ id, name: entry.name }))
}

export function nowView(db: DatabaseSync, options: { all?: boolean; sessions?: LiveSession[] } = {}): NowView {
  const features = listFeatures(db)
    .filter((feature) => options.all === true || (feature.status !== 'done' && feature.status !== 'cancelled'))
    .map((feature) => {
    const stages = listStages(db, feature.id)
    const done = stages.filter((item) => item.status === 'merged').length
    const finished = stages.length > 0 && done === stages.length

    // показываем то, что происходит сейчас: работающий этап, затем принятый (ждёт слияния),
    // затем на ревью, затем ближайший запланированный, и только потом первый.
    // у завершённой фичи «сейчас» — последний этап, иначе номер снова начинался бы с первого
    const stage = finished
      ? stages[stages.length - 1]
      : stages.find((item) => item.status === 'active') ??
        stages.find((item) => item.status === 'accepted') ??
        stages.find((item) => item.status === 'in_review') ??
        stages.find((item) => item.status === 'planned') ??
        stages[0] ??
        null

    const counts: Record<string, number> = {}
    if (stage) {
      for (const task of listTasks(db, { stageId: stage.id })) {
        counts[task.status] = (counts[task.status] ?? 0) + 1
      }
    }

    return {
      id: feature.id,
      name: feature.name,
      rank: feature.rank,
      status: feature.status,
      finished: finished || feature.status === 'done',
      decisions: listDecisions(db, { subjectId: feature.id }).map((decision) => ({
        question: decision.question,
        choice: decision.choice,
      })),
      stage: {
        id: stage?.id ?? '',
        seq: stages.length === 0 ? 0 : finished ? stages.length : done + 1,
        total: stages.length,
        done,
        counts,
      },
    }
  })

  const pool = listTasks(db, { status: 'ready' as TaskStatus })
    .filter((task) => task.stageId === null)
    .map((task) => ({ id: task.id, title: task.title }))

  const run = activeRun(db)
  const holders = listExecutors(db).map((executor) => {
    const active = listTasks(db, { holder: executor.id, status: 'active' as TaskStatus })
    const hand = getHand(db, executor.id).map((task) => task.id)
    const busy = busyOf(db, executor.id)
    // работа — это своя задача, непустая рука или (у оркестратора) идущий прогон.
    // субагенты считаются чужой работой: пока они живы, worker-0 сам не работает.
    const working =
      active.length > 0 || hand.length > 0 || (executor.id === 'worker-0' && run !== null)
    return {
      executor: executor.id,
      session: executor.session,
      task: active[0]?.id ?? null,
      active: active.map((task) => task.id),
      hand,
      busy: busy ? { reason: busy.reason, until: busy.until } : null,
      working,
    }
  })

  // тот же источник, что у `request open`: запрос, закрытый по фичам, открытым не считается
  const requests = openRequests(db).map((request) => ({ id: request.id, title: request.title }))

  const plans = db
    .prepare(
      `select p.id as id, p.request_id as requestId, p.title as title
       from plans p join requests r on r.id = p.request_id
       where p.approved_at is null and p.applied_at is null
         and r.status != 'closed'
         and not exists (
           select 1 from plans q where q.request_id = p.request_id and q.version > p.version
         )
       order by p.id`,
    )
    .all() as Array<{ id: string; requestId: string; title: string }>

  return {
    features,
    pool,
    holders,
    requests,
    plans,
    waitingMain: waitingMainFeatures(db),
    sessions: options.sessions ?? [],
    unreleased: pendingRelease(db).length,
    assignment: assignmentStats(db),
  }
}

const SESSION_TITLE_LIMIT = 40

/**
 * Состояние живого субагента без имени агента: «занят · заголовок».
 * Одна и та же строка идёт и в строку исполнителя, и в строку сессии без исполнителя:
 * имя агента стоит в начале строки, второй раз его не печатаем.
 * Заголовок режется до 40 символов; многоточие входит в лимит.
 */
export function sessionState(session: LiveSession): string {
  const title = session.title || 'без названия'
  const short = title.length > SESSION_TITLE_LIMIT ? `${title.slice(0, SESSION_TITLE_LIMIT - 1)}…` : title
  return `${session.busy ? 'занят' : 'простаивает'} · ${short}`
}

// владельцу нужен не журнал, а картина работы: строка на каждый этап.
// группы не выносятся в заголовки — порядок строк и есть группировка.
export type OwnerStageStatus = 'done' | 'merge' | 'wip' | 'pending'

export interface OwnerStageRow {
  featureId: string
  featureName: string
  stageId: string
  seq: number
  total: number
  progress: { current: number; total: number }
  status: OwnerStageStatus
  name: string
}

export interface OwnerView {
  stages: OwnerStageRow[]
}

// статус этапа — по движению, а не по флагу: plan apply активирует этап, но работы в нём ещё нет.
const ownerStageStatus = (stage: StageStatus, started: boolean, allDone: boolean): OwnerStageStatus | null => {
  if (stage === 'merged') return 'done'
  if (stage === 'abandoned') return null
  if (!started) return 'pending'
  if (allDone) return 'merge'
  return 'wip'
}

const ownerStatusRank: Record<OwnerStageStatus, number> = { done: 0, merge: 1, wip: 2, pending: 3 }

// прогресс — текущая задача из всех задач этапа: до работы 0/3, в работе 2/3, после двух закрытых 3/3.
const stageProgress = (
  db: DatabaseSync,
  stageId: string,
  started = true,
): { current: number; total: number } => {
  const tasks = listTasks(db, { stageId })
  const total = tasks.length
  if (total === 0 || !started) return { current: 0, total }

  const completed = tasks.filter((task) => task.status === 'done' || task.status === 'cancelled').length
  return { current: Math.min(total, completed + 1), total }
}

/** Этап начат, если по нему была работа: задача взята, закрыта или этап ушёл на приёмку. */
const stageStarted = (db: DatabaseSync, stageId: string, stage: StageStatus): boolean => {
  if (stage === 'in_review' || stage === 'accepted' || stage === 'merged') return true
  return listTasks(db, { stageId }).some((task) => task.status === 'done' || task.status === 'active')
}

export function ownerView(db: DatabaseSync, options: { all?: boolean } = {}): OwnerView {
  const rows: Array<{ rank: number; row: OwnerStageRow }> = []

  for (const feature of listFeatures(db)) {
    if (options.all !== true && (feature.status === 'done' || feature.status === 'cancelled')) continue

    const stages = listStages(db, feature.id)
    const tasks = stages.flatMap((stage) => listTasks(db, { stageId: stage.id }))
    const total = tasks.length
    const completed = tasks.filter((task) => task.status === 'done' || task.status === 'cancelled').length

    // статус фичи — худшее из её этапов: сначала проверяем, всё ли слито, потом всё ли закрыто
    const stageStates = stages
      .map((stage) => {
        const stageTasks = listTasks(db, { stageId: stage.id })
        const started = stageStarted(db, stage.id, stage.status)
        const allDone =
          stageTasks.length > 0 &&
          stageTasks.every((task) => task.status === 'done' || task.status === 'cancelled')
        return ownerStageStatus(stage.status, started, allDone)
      })
      .filter((status): status is OwnerStageStatus => status !== null)

    const allMerged = stageStates.length > 0 && stageStates.every((status) => status === 'done')
    const allClosed = total > 0 && completed === total

    let status: OwnerStageStatus
    if (feature.status === 'done' || allMerged) status = 'done'
    else if (allClosed || stageStates.includes('merge')) status = 'merge'
    else if (stageStates.includes('wip')) status = 'wip'
    else status = 'pending'

    // пустая фича без этапов остаётся видимой: иначе только что созданная фича исчезает с доски
    rows.push({
      rank: feature.rank,
      row: {
        featureId: feature.id,
        featureName: feature.name,
        stageId: stages.length > 0 ? stages[stages.length - 1].id : '',
        seq: stages.length,
        total: stages.length,
        progress: { current: completed, total },
        status,
        name: feature.name,
      },
    })
  }

  rows.sort(
    (a, b) =>
      ownerStatusRank[a.row.status] - ownerStatusRank[b.row.status] ||
      a.rank - b.rank ||
      a.row.featureId.localeCompare(b.row.featureId) ||
      a.row.seq - b.row.seq,
  )

  return { stages: rows.map((item) => item.row) }
}

export interface DispatchEntry {
  executor: string
  session: string | null
  tasks: string[]
  newTask: string | null
}

export interface DispatchPlan {
  assignments: DispatchEntry[]
  warnings: string[]
}

export function dispatchPlan(db: DatabaseSync): DispatchPlan {
  advanceTime(db)
  dispatchHands(db)

  const executors = listExecutors(db)
  const assignments: DispatchEntry[] = executors.map((executor) => {
    const hand = getHand(db, executor.id)
    return {
      executor: executor.id,
      session: executor.session,
      tasks: hand.map((task) => task.id),
      newTask: nextTask(db, executor.id)?.id ?? null,
    }
  })

  const knownSkills = new Set(executors.flatMap((executor) => executor.skills))
  const unstaffed = new Set(
    listTasks(db, { status: 'ready' })
      .map((task) => task.skill)
      .filter((skill) => !knownSkills.has(skill)),
  )

  const warnings = [...unstaffed].map((skill) => `навык ${skill} ни у одного исполнителя: задачи стоят`)

  for (const feature of listFeatures(db)) {
    if (feature.status === 'active' && !feature.worktree) {
      warnings.push(`фича ${feature.id} активна без рабочего каталога: выполните feature start ${feature.id}`)
    }
  }

  return { assignments, warnings }
}




