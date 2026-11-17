import type { DatabaseSync } from 'node:sqlite'
import { UserError } from '../cli/errors.ts'
import { tx } from './db.ts'
import { appendEvent } from './events.ts'
import { depsOf, isSatisfied } from './deps.ts'
import { getExecutor, listExecutors, type Executor } from './executors.ts'
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

    const ordered = candidateOrder(db, executor)

    const base = getHand(db, executorId).length
    ordered.slice(0, free).forEach((task, index) => {
      db.prepare(
        'insert or ignore into hand (executor_id, position, task_id, reserved_at) values (?, ?, ?, ?)',
      ).run(executorId, base + index + 1, task.id, new Date().toISOString())
    })

    return getHand(db, executorId)
  })
}

/** Порядок подходящих задач для исполнителя. Ничего не пишет: резервирует только fillHand. */
function candidateOrder(db: DatabaseSync, executor: Executor): Task[] {
  const affinity = currentStage(db, executor.id)
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
  return ordered
}

/** Задачи, которые ждут задачу: цепочка шагов закрывается после неё, поэтому едет в одной руке. */
function followersOf(db: DatabaseSync, taskId: string): string[] {
  return (
    db.prepare('select from_id as id from deps where to_id = ? order by from_id').all(taskId) as Array<{ id: string }>
  ).map((row) => row.id)
}

/** Задача годится в руку исполнителя: навык подходит, чужих резервов нет, ждёт только эту руку. */
function canHold(db: DatabaseSync, executor: Executor, taskId: string, taken: Set<string>): boolean {
  if (taken.has(taskId)) return false

  const task = getTask(db, taskId)
  if (!task) return false
  if (task.status !== 'ready' && task.status !== 'open') return false
  if (task.holder !== null) return false
  if (!executor.skills.includes(task.skill)) return false
  if (db.prepare('select 1 as found from hand where task_id = ?').get(taskId)) return false

  // задача этапа живёт в активном этапе работающей фичи — как и в candidateOrder
  if (task.stageId !== null) {
    const row = db
      .prepare(
        'select st.status as stageStatus, f.worktree as worktree from stages st ' +
          'join features f on f.id = st.feature_id where st.id = ?',
      )
      .get(task.stageId) as { stageStatus: string; worktree: string | null } | undefined
    if (!row || row.stageStatus !== 'active' || row.worktree === null) return false
  }

  return unmetDep(db, taskId, taken) === null
}

/** Задача и её зависимые шаги до размера руки: цепочку не рвут между исполнителями. */
function chainOf(db: DatabaseSync, executor: Executor, baseId: string, taken: Set<string>): string[] {
  const chain: string[] = []
  const queue = [baseId]

  while (queue.length > 0 && taken.size < executor.handSize) {
    const current = queue.shift()!
    for (const follower of followersOf(db, current)) {
      if (taken.size >= executor.handSize) break
      if (!canHold(db, executor, follower, taken)) continue
      taken.add(follower)
      chain.push(follower)
      queue.push(follower)
    }
  }

  return chain
}

function reserve(db: DatabaseSync, executorId: string, ids: string[], base: number): number {
  const at = new Date().toISOString()
  let inserted = 0
  ids.forEach((id, index) => {
    const result = db
      .prepare('insert or ignore into hand (executor_id, position, task_id, reserved_at) values (?, ?, ?, ?)')
      .run(executorId, base + index + 1, id, at)
    inserted += Number(result.changes)
  })
  return inserted
}

/**
 * Раздача руки по кругам: независимые задачи — по одной каждому исполнителю с подходящим
 * навыком и свободным местом в руке, остаток уходит следующим кругом. Один исполнитель
 * не забирает всё, пока другой свободен, и одна задача достаётся одной руке.
 * За задачей в руку достраивается её цепочка — то, что setHand принимает одним списком.
 */
export function dispatchHands(db: DatabaseSync): void {
  tx(db, () => {
    const executors = listExecutors(db)
    const stuck = new Set<string>()

    for (;;) {
      let placed = false

      for (const executor of executors) {
        const hand = getHand(db, executor.id).map((task) => task.id)
        if (hand.length >= executor.handSize) continue

        const base = candidateOrder(db, executor).find((task) => !stuck.has(task.id))
        if (!base) continue

        const taken = new Set(hand)
        taken.add(base.id)
        const ids = [base.id, ...chainOf(db, executor, base.id, taken)]

        if (reserve(db, executor.id, ids, hand.length) === 0) {
          stuck.add(base.id)
          continue
        }
        placed = true
      }

      if (!placed) break
    }
  })
}

/** Задачи руки в её порядке: готовые к работе и следующие шаги, ждущие своей очереди. */
export function getHand(db: DatabaseSync, executorId: string): Task[] {
  const rows = db
    .prepare('select task_id from hand where executor_id = ? order by position, task_id')
    .all(executorId) as Array<{ task_id: string }>

  return rows
    .map((row) => getTask(db, row.task_id))
    .filter((task): task is Task => task !== null && (task.status === 'ready' || task.status === 'open'))
}

/** Первая незакрытая зависимость задачи, которой нет в руке; null — задача никого не ждёт. */
function unmetDep(db: DatabaseSync, taskId: string, hand: Set<string>): string | null {
  for (const dep of depsOf(db, taskId)) {
    if (isSatisfied(db, dep)) continue
    if (hand.has(dep)) continue
    return dep
  }
  return null
}

export function setHand(db: DatabaseSync, executorId: string, taskIds: string[], actor: string): Task[] {
  return tx(db, () => {
    const executor = getExecutor(db, executorId)
    if (!executor) throw new UserError(3, `исполнитель ${executorId} не найден`)

    // повтор в списке — не ошибка: одна задача занимает в руке одно место
    // лишнее за размером руки просто не влезает: цепочка обрывается на границе, это не ошибка
    const wanted = [...new Set(taskIds)]
    const ids = wanted.slice(0, executor.handSize)
    const hand = new Set(ids)

    for (const id of ids) {
      const task = getTask(db, id)
      if (!task) throw new UserError(3, `задача ${id} не найдена`)
      if (task.status !== 'ready' && task.status !== 'open') {
        throw new UserError(3, `задача ${id} не в очереди: ${task.status}`)
      }

      const waiting = unmetDep(db, id, hand)
      if (waiting) {
        throw new UserError(3, `задача ${id} ждёт зависимость ${waiting}: она не закрыта и не лежит в руке`)
      }

      const reserved = db
        .prepare('select executor_id from hand where task_id = ? and executor_id != ?')
        .get(id, executorId) as { executor_id: string } | undefined
      if (reserved) {
        throw new UserError(3, `задача ${id} уже зарезервирована за ${reserved.executor_id}`)
      }
    }

    db.prepare('delete from hand where executor_id = ?').run(executorId)
    ids.forEach((id, index) => {
      db.prepare(
        'insert into hand (executor_id, position, task_id, reserved_at) values (?, ?, ?, ?)',
      ).run(executorId, index + 1, id, new Date().toISOString())
    })

    appendEvent(db, {
      type: 'hand.set',
      actor,
      subject: executorId,
      after: { tasks: ids },
    })

    return getHand(db, executorId)
  })
}

export function nextTask(db: DatabaseSync, executorId: string): Task | null {
  const executor = getExecutor(db, executorId)
  if (!executor) return null

  // рука — обещание: сначала берём из неё, в её порядке.
  const hand = getHand(db, executorId)
  if (hand.length > 0) return hand[0]

  // руки нет — берём одну лучшую задачу, но не бронируем остальные: это дело dispatch.
  return candidateOrder(db, executor)[0] ?? null
}
