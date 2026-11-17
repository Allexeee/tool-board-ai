import type { DatabaseSync } from 'node:sqlite'
import { UserError } from '../cli/errors.ts'
import { tx } from './db.ts'
import { appendEvent } from './events.ts'
import { getExecutor } from './executors.ts'
import { getTask, type Task } from './tasks.ts'

const CLASS_ORDER: Record<string, number> = {
  expedite: 0,
  fixed_date: 1,
  standard: 2,
  quick: 3,
  intangible: 4,
}

const SIZE_ORDER: Record<string, number> = { XS: 0, S: 1, M: 2, L: 3 }

export function compareTasks(a: Task, b: Task): number {
  const byClass = (CLASS_ORDER[a.class] ?? 9) - (CLASS_ORDER[b.class] ?? 9)
  if (byClass !== 0) return byClass

  const bySize = (SIZE_ORDER[a.size] ?? 9) - (SIZE_ORDER[b.size] ?? 9)
  if (bySize !== 0) return bySize

  return a.id.localeCompare(b.id)
}

interface Candidate {
  id: string
  skill: string
  klass: string
  featureId: string
  featureRank: number
  stageId: string
  stageSeq: number
}

function candidates(db: DatabaseSync): Candidate[] {
  return db
    .prepare(
      `select t.id as id, t.skill as skill, t.class as klass, st.feature_id as featureId,
              f.rank as featureRank, st.id as stageId, st.seq as stageSeq
       from tasks t
       join stages st on st.id = t.stage_id
       join features f on f.id = st.feature_id
       where t.status = 'ready'
         and st.status = 'active'
         and f.worktree is not null
         and t.holder is null
         and t.id not in (select task_id from hand)`,
    )
    .all() as unknown as Candidate[]
}

function currentStage(db: DatabaseSync, executorId: string): { featureId: string | null; stageId: string | null } {
  const row = db
    .prepare(
      `select st.feature_id as featureId, t.stage_id as stageId
       from events e
       join tasks t on t.id = e.subject
       join stages st on st.id = t.stage_id
       where e.type = 'task.taken' and e.actor = ?
       order by e.id desc limit 1`,
    )
    .get(executorId) as { featureId: string; stageId: string } | undefined

  return { featureId: row?.featureId ?? null, stageId: row?.stageId ?? null }
}

export function fillHand(db: DatabaseSync, executorId: string, limit?: number): Task[] {
  return tx(db, () => {
    const executor = getExecutor(db, executorId)
    if (!executor) throw new UserError(3, `исполнитель ${executorId} не найден`)

    const size = limit ?? executor.handSize
    const free = size - getHand(db, executorId).length
    if (free <= 0) return getHand(db, executorId)

    const affinity = currentStage(db, executorId)
    const pool = candidates(db)
      .filter((candidate) => executor.skills.includes(candidate.skill))
      .map((candidate) => ({ candidate, task: getTask(db, candidate.id)! }))

    pool.sort((a, b) => {
      if (affinity.featureId !== null) {
        const aSame = a.candidate.featureId === affinity.featureId ? 0 : 1
        const bSame = b.candidate.featureId === affinity.featureId ? 0 : 1
        if (aSame !== bSame) return aSame - bSame
      }
      const byRank = a.candidate.featureRank - b.candidate.featureRank
      if (byRank !== 0) return byRank
      const byStage = a.candidate.stageSeq - b.candidate.stageSeq
      if (byStage !== 0) return byStage
      return compareTasks(a.task, b.task)
    })

    const ordered = pool.map((item) => item.task)

    const poolTasks = (
      db
        .prepare(
          "select id from tasks where stage_id is null and status = 'ready' and holder is null " +
            'and id not in (select task_id from hand)',
        )
        .all() as Array<{ id: string }>
    )
      .map((row) => getTask(db, row.id)!)
      .filter((task) => task && executor.skills.includes(task.skill))
      .sort(compareTasks)

    ordered.push(...poolTasks)

    const base = getHand(db, executorId).length
    ordered.slice(0, free).forEach((task, index) => {
      db.prepare(
        'insert or ignore into hand (executor_id, position, task_id, reserved_at) values (?, ?, ?, ?)',
      ).run(executorId, base + index + 1, task.id, new Date().toISOString())
    })

    return getHand(db, executorId)
  })
}

export function getHand(db: DatabaseSync, executorId: string): Task[] {
  const rows = db
    .prepare('select task_id from hand where executor_id = ? order by position, task_id')
    .all(executorId) as Array<{ task_id: string }>

  return rows
    .map((row) => getTask(db, row.task_id))
    .filter((task): task is Task => task !== null && task.status === 'ready')
}

export function setHand(db: DatabaseSync, executorId: string, taskIds: string[], actor: string): Task[] {
  return tx(db, () => {
    if (!getExecutor(db, executorId)) throw new UserError(3, `исполнитель ${executorId} не найден`)

    for (const id of taskIds) {
      const task = getTask(db, id)
      if (!task) throw new UserError(3, `задача ${id} не найдена`)
      if (task.status !== 'ready') throw new UserError(3, `задача ${id} не готова: ${task.status}`)

      const reserved = db
        .prepare('select executor_id from hand where task_id = ? and executor_id != ?')
        .get(id, executorId) as { executor_id: string } | undefined
      if (reserved) {
        throw new UserError(3, `задача ${id} уже зарезервирована за ${reserved.executor_id}`)
      }
    }

    db.prepare('delete from hand where executor_id = ?').run(executorId)
    taskIds.forEach((id, index) => {
      db.prepare(
        'insert into hand (executor_id, position, task_id, reserved_at) values (?, ?, ?, ?)',
      ).run(executorId, index + 1, id, new Date().toISOString())
    })

    appendEvent(db, {
      type: 'hand.set',
      actor,
      subject: executorId,
      after: { tasks: taskIds },
    })

    return getHand(db, executorId)
  })
}

export function nextTask(db: DatabaseSync, executorId: string): Task | null {
  const executor = getExecutor(db, executorId)
  if (!executor) return null

  const urgent = candidates(db).find(
    (candidate) => candidate.klass === 'expedite' && executor.skills.includes(candidate.skill),
  )
  if (urgent) return getTask(db, urgent.id)

  const hand = fillHand(db, executorId)
  return hand[0] ?? null
}
