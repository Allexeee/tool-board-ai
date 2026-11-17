import type { DatabaseSync } from 'node:sqlite'
import { advanceTime } from './clock.ts'
import { listFeatures } from './features.ts'
import { listStages, type StageStatus } from './stages.ts'
import { busyOf, listExecutors } from './executors.ts'
import { listTasks, type TaskStatus } from './tasks.ts'
import { getHand, fillHand, nextTask } from './hands.ts'
import { ownerHand } from './questions.ts'
import { listDecisions } from './decisions.ts'
import { listRequests } from './requests.ts'
import { pendingRelease } from './git/release.ts'

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

  const executors = listExecutors(db)
  const assignments: DispatchEntry[] = executors.map((executor) => {
    const hand = fillHand(db, executor.id)
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



