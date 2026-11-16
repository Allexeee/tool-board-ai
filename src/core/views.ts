import type { DatabaseSync } from 'node:sqlite'
import { advanceTime } from './clock.ts'
import { listFeatures } from './features.ts'
import { listStages } from './stages.ts'
import { listExecutors } from './executors.ts'
import { listTasks, type TaskStatus } from './tasks.ts'
import { fillHand, nextTask } from './hands.ts'
import { ownerHand } from './questions.ts'

export interface NowView {
  features: Array<{
    id: string
    name: string
    rank: number
    stage: { id: string; seq: number; total: number; counts: Record<string, number> }
  }>
  holders: Array<{ executor: string; task: string | null }>
  waitingOwner: number
}

export function nowView(db: DatabaseSync): NowView {
  const features = listFeatures(db).map((feature) => {
    const stages = listStages(db, feature.id)
    // показываем то, что происходит сейчас: активный этап, иначе ближайший запланированный,
    // и только если таких нет — первый (например, уже слитый)
    const stage =
      stages.find((item) => item.status === 'active') ??
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
      stage: {
        id: stage?.id ?? '',
        seq: stage?.seq ?? 0,
        total: stages.length,
        counts,
      },
    }
  })

  const holders = listExecutors(db).map((executor) => {
    const active = listTasks(db, { holder: executor.id, status: 'active' as TaskStatus })[0]
    return { executor: executor.id, task: active?.id ?? null }
  })

  return { features, holders, waitingOwner: ownerHand(db).length }
}

export interface DispatchEntry {
  executor: string
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

  return { assignments, warnings }
}
