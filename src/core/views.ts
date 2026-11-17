import type { DatabaseSync } from 'node:sqlite'
import { advanceTime } from './clock.ts'
import { listFeatures } from './features.ts'
import { listStages, type StageStatus } from './stages.ts'
import { busyOf, listExecutors } from './executors.ts'
import { listTasks, type TaskStatus } from './tasks.ts'
import { depsOf, isSatisfied } from './deps.ts'
import { getHand, dispatchHands, nextTask } from './hands.ts'
import { ownerHand } from './questions.ts'
import { listDecisions } from './decisions.ts'
import { listRequests } from './requests.ts'
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

/**
 * Порядок, в котором задачи будут взяты: ранг фичи, номер этапа, затем зависимости.
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

    const deps = (db.prepare('select from_id from deps where to_id = ?').all(id) as Array<{ from_id: string }>)
      .map((row) => row.from_id)
      .filter((dep) => byId.has(dep))

    const value = deps.length === 0 ? 0 : Math.max(...deps.map((dep) => depthOf(dep, seen) + 1))
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

  return tasks
    .map((task) => {
      const place = task.stageId ? seqOf.get(task.stageId) : undefined
      const featureId = place?.featureId ?? null
      const waitsFor = depsOf(db, task.id).filter((dep) => !isSatisfied(db, dep))

      // назначенная задача никого не ждёт: причина есть только у свободной.
      const reason =
        task.holder !== null || handOf.has(task.id)
          ? null
          : reasonOf({ task, place, waitsFor, feature: featureId ? featureOf.get(featureId) : undefined, executors, isBusy })

      return {
        row: {
          taskId: task.id,
          title: task.title,
          status: task.status,
          featureId,
          stageId: task.stageId,
          waitsFor,
          holder: task.holder,
          hand: handOf.get(task.id) ?? null,
          reason,
        } satisfies QueueRow,
        sort: {
          rank: featureId ? (rankOf.get(featureId) ?? 99) : 999,
          seq: place?.seq ?? 999,
          depth: depthOf(task.id),
          id: task.id,
        },
      }
    })
    .sort((a, b) => a.sort.rank - b.sort.rank || a.sort.seq - b.sort.seq || a.sort.depth - b.sort.depth || a.sort.id.localeCompare(b.sort.id))
    .map((item) => item.row)
}

/**
 * Порядок проверок — от того, что можно исправить, к тому, что просто ждёт:
 * зависимость, статус, этап, каталог, навык, занятость. Всё остальное — недораздача.
 */
function reasonOf(input: {
  task: { status: TaskStatus; stageId: string | null; skill: string }
  place: { status: StageStatus } | undefined
  waitsFor: string[]
  feature: { worktree: string | null } | undefined
  executors: Array<{ id: string; skills: string[]; handSize: number }>
  isBusy: (executorId: string, handSize: number) => boolean
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
  }>
  waitingOwner: number
  requests: Array<{ id: string; title: string }>
  plans: Array<{ id: string; requestId: string; title: string }>
  unreleased: number
}

export function nowView(db: DatabaseSync, options: { all?: boolean } = {}): NowView {
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

  const holders = listExecutors(db).map((executor) => {
    const active = listTasks(db, { holder: executor.id, status: 'active' as TaskStatus })
    const busy = busyOf(db, executor.id)
    return {
      executor: executor.id,
      session: executor.session,
      task: active[0]?.id ?? null,
      active: active.map((task) => task.id),
      hand: getHand(db, executor.id).map((task) => task.id),
      busy: busy ? { reason: busy.reason, until: busy.until } : null,
    }
  })

  const requests = listRequests(db)
    .filter((request) => request.status === 'inbox')
    .map((request) => ({ id: request.id, title: request.title }))

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
    waitingOwner: ownerHand(db).length,
    requests,
    plans,
    unreleased: pendingRelease(db).length,
  }
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
    const stageRows: OwnerStageRow[] = []

    for (const stage of stages) {
      const tasks = listTasks(db, { stageId: stage.id })
      const started = stageStarted(db, stage.id, stage.status)
      const allDone = tasks.length > 0 && tasks.every((task) => task.status === 'done' || task.status === 'cancelled')
      const status = ownerStageStatus(stage.status, started, allDone)
      if (!status) continue

      stageRows.push({
        featureId: feature.id,
        featureName: feature.name,
        stageId: stage.id,
        seq: stage.seq,
        total: stages.length,
        progress: stageProgress(db, stage.id, started),
        status,
        name: stage.name,
      })
    }

    // вся фича сделана: один этап не показываем отдельной строкой — владельцу нужен факт, а не разбивка.
    if (stageRows.length > 1 && stageRows.every((row) => row.status === 'done')) {
      const tasks = stages.flatMap((stage) => listTasks(db, { stageId: stage.id }))
      const total = tasks.length
      const completed = tasks.filter((task) => task.status === 'done' || task.status === 'cancelled').length

      rows.push({
        rank: feature.rank,
        row: {
          featureId: feature.id,
          featureName: feature.name,
          stageId: stages[stages.length - 1].id,
          seq: stages.length,
          total: stages.length,
          progress: { current: total === 0 ? 0 : completed, total },
          status: 'done',
          name: feature.name,
        },
      })
      continue
    }

    for (const row of stageRows) rows.push({ rank: feature.rank, row })
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



