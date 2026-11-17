import type { DatabaseSync } from 'node:sqlite'
import { advanceTime } from './clock.ts'
import { listFeatures } from './features.ts'
import { listStages } from './stages.ts'
import { listExecutors } from './executors.ts'
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
  holders: Array<{ executor: string; task: string | null; active: string[]; hand: string[]; session: string | null }>
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
    return {
      executor: executor.id,
      session: executor.session,
      task: active[0]?.id ?? null,
      active: active.map((task) => task.id),
      hand: getHand(db, executor.id).map((task) => task.id),
    }
  })

  const requests = listRequests(db)
    .filter((request) => request.status === 'inbox')
    .map((request) => ({ id: request.id, title: request.title }))

  const plans = db
    .prepare(
      "select id, request_id as requestId, title from plans where approved_at is null and applied_at is null order by id",
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



