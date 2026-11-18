import type { DatabaseSync } from 'node:sqlite'
import { UserError } from '../cli/errors.ts'
import { tx } from './db.ts'
import { appendEvent } from './events.ts'
import { depsOf, isSatisfied } from './deps.ts'
import { getExecutor, listExecutors, type Executor } from './executors.ts'
import { getTask, type Task } from './tasks.ts'
import { isReady } from './deps.ts'
import { activeRun } from './runs.ts'

const CLASS_ORDER: Record<string, number> = {
  expedite: 0,
  fixed_date: 1,
  standard: 2,
  quick: 3,
  intangible: 4,
}

const SIZE_ORDER: Record<string, number> = { XS: 0, S: 1, M: 2, L: 3 }

/** Откуда задача попала исполнителю: раздачей, прямой рукой или взятием по id из очереди. */
export type AssignSource = 'dispatch' | 'hand' | 'take'

/**
 * След выдачи в журнале: без него резерв в hand не виден владельцу.
 * Одно событие — одна выдача: кто получил, что получил и откуда.
 */
export function appendAssigned(
  db: DatabaseSync,
  executorId: string,
  taskId: string,
  source: AssignSource,
  actor = 'system',
): void {
  appendEvent(db, {
    type: 'hand.assigned',
    actor,
    subject: executorId,
    after: { executor: executorId, task: taskId, source },
  })
}

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
      const result = db
        .prepare(
          'insert or ignore into hand (executor_id, position, task_id, reserved_at) values (?, ?, ?, ?)',
        )
        .run(executorId, base + index + 1, task.id, new Date().toISOString())
      if (Number(result.changes) > 0) appendAssigned(db, executorId, task.id, 'hand')
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

/**
 * Кто уже держит этап: у кого его задача в работе или в руке. Задачи одного этапа живут
 * в одном рабочем каталоге, поэтому этап не делят между исполнителями.
 * Слитый этап ничей: его задачи закрыты, в очереди и в руке их нет.
 */
export function stageOwner(db: DatabaseSync, stageId: string): string | null {
  const inWork = db
    .prepare(
      "select holder as owner from tasks where stage_id = ? and status = 'active' and holder is not null " +
        'order by id limit 1',
    )
    .get(stageId) as { owner: string } | undefined
  if (inWork) return inWork.owner

  const reserved = db
    .prepare(
      'select h.executor_id as owner from hand h join tasks t on t.id = h.task_id ' +
        "where t.stage_id = ? and t.status in ('ready', 'open') order by h.position limit 1",
    )
    .get(stageId) as { owner: string } | undefined
  return reserved?.owner ?? null
}

/**
 * Этап не делят: его задачи достаются тому, кто уже держит этап. Свободный этап и пул — любому.
 * Правило одно для раздачи и для руки, выставленной вручную.
 */
export function ownsStage(db: DatabaseSync, executorId: string, stageId: string | null): boolean {
  if (stageId === null) return true
  const owner = stageOwner(db, stageId)
  return owner === null || owner === executorId
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

  // этап не делят: задачу этапа, который уже держит другая рука, сюда не берут
  if (!ownsStage(db, executor.id, task.stageId)) return false

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

/** Резервирует задачи в руке и возвращает те, что действительно встали: событие — на каждую. */
function reserve(db: DatabaseSync, executorId: string, ids: string[], base: number): string[] {
  const at = new Date().toISOString()
  const inserted: string[] = []
  // автораздача не оживляет исполнителя: иначе рука мёртвого агента не снимается никогда
  ids.forEach((id, index) => {
    const result = db
      .prepare('insert or ignore into hand (executor_id, position, task_id, reserved_at) values (?, ?, ?, ?)')
      .run(executorId, base + index + 1, id, at)
    if (Number(result.changes) > 0) {
      inserted.push(id)
      appendAssigned(db, executorId, id, 'dispatch')
    }
  })
  return inserted
}

/**
 * Раздача руки по кругам: независимые задачи — по одной каждому исполнителю с подходящим
 * навыком и свободным местом в руке, остаток уходит следующими кругами. Один исполнитель
 * не забирает всё, пока другой свободен, и одна задача достаётся одной руке.
 * Задачи одного этапа не делят: этап целиком достаётся тому, кто первый его взял, —
 * иначе две руки правят один рабочий каталог фичи. Слитый этап задачами больше не связан.
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

        const free = candidateOrder(db, executor).filter((task) => !stuck.has(task.id))
        // сначала добираем свой этап: остальные его задачи другой руке уже не достанутся
        const base =
          free.find((task) => task.stageId !== null && stageOwner(db, task.stageId) === executor.id) ??
          free.find((task) => ownsStage(db, executor.id, task.stageId))
        if (!base) continue

        const taken = new Set(hand)
        taken.add(base.id)
        const ids = [base.id, ...chainOf(db, executor, base.id, taken)]

        if (reserve(db, executor.id, ids, hand.length).length === 0) {
          stuck.add(base.id)
          continue
        }
        placed = true
      }

      if (!placed) break
    }
  })
}

/**
 * Автодобор после события (задача закрыта, этап слит): только пока прогон идёт.
 * Вне прогона руки никто не разбирает, а резерв молча исключает задачи из очереди —
 * поэтому за пределами прогона не наполняем.
 */
export function refillHands(db: DatabaseSync): boolean {
  if (!activeRun(db)) return false
  dispatchHands(db)
  return true
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

      // этап не делят и руками: его задачи живут в одном рабочем каталоге фичи.
      // правило то же, что у раздачи, — иначе рука открывает вторую дверь в тот же каталог.
      if (task.stageId !== null && !ownsStage(db, executorId, task.stageId)) {
        throw new UserError(3, `этап ${task.stageId} уже у ${stageOwner(db, task.stageId)}`)
      }
    }

    // что уже выдано этой руке: повторная установка тех же задач — не новая выдача
    const previous = new Set(
      (
        db.prepare('select task_id from hand where executor_id = ?').all(executorId) as Array<{
          task_id: string
        }>
      ).map((row) => row.task_id),
    )

    db.prepare('delete from hand where executor_id = ?').run(executorId)
    // рука выставлена сейчас — исполнитель жив, иначе ближайший advanceTime её снимет
    db.prepare('update executors set last_seen = ? where id = ?').run(new Date().toISOString(), executorId)
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

    // событие — только на новую выдачу: переустановка той же руки ничего не выдаёт заново
    for (const id of ids) {
      if (!previous.has(id)) appendAssigned(db, executorId, id, 'hand', actor)
    }

    return getHand(db, executorId)
  })
}

/**
 * Освободить руку целиком: строки руки удаляются, задача снова свободна для раздачи.
 * Событие хранит, что именно сняли: иначе бронь исчезает бесследно.
 */
export function clearHand(db: DatabaseSync, executorId: string, actor: string): string[] {
  return tx(db, () => {
    const executor = getExecutor(db, executorId)
    if (!executor) throw new UserError(3, `исполнитель ${executorId} не найден`)

    const tasks = (
      db
        .prepare('select task_id from hand where executor_id = ? order by position, task_id')
        .all(executorId) as Array<{ task_id: string }>
    ).map((row) => row.task_id)

    db.prepare('delete from hand where executor_id = ?').run(executorId)
    appendEvent(db, {
      type: 'hand.cleared',
      actor,
      subject: executorId,
      after: { tasks },
    })

    return tasks
  })
}

export function nextTask(db: DatabaseSync, executorId: string): Task | null {
  const executor = getExecutor(db, executorId)
  if (!executor) return null

  // рука — обещание: берём из неё в её порядке, но только то, что действительно можно взять сейчас.
  const hand = getHand(db, executorId)
  if (hand.length > 0) {
    return hand.find((task) => task.status === 'ready' && isReady(db, task.id)) ?? null
  }

  // руки нет — берём одну лучшую задачу, но не бронируем остальные: это дело dispatch.
  return candidateOrder(db, executor)[0] ?? null
}
