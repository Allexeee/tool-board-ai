import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { addExecutor, type NewExecutorInput } from '../../src/core/executors.ts'
import { createCard, getCard, type NewCardInput } from '../../src/core/cards.ts'
import { nowIso } from '../../src/core/clock.ts'
import { openDb } from '../../src/core/db.ts'
import { allocateId } from '../../src/core/ids.ts'
import { initProject } from '../../src/core/project.ts'
import { getRun } from '../../src/core/runs.ts'
import type {
  Card,
  CardPhase,
  CardStatus,
  Executor,
  Run,
  RunStatus,
} from '../../src/core/types.ts'

export interface BoardFixture {
  root: string
  db: DatabaseSync
  close: () => void
}

/** Временная доска: initProject, открытая база и уборка каталога. */
export function makeBoard(): BoardFixture {
  const root = mkdtempSync(join(tmpdir(), 'board-'))
  initProject(root)
  const db = openDb(join(root, '.board', 'board.db'))
  let closed = false

  return {
    root,
    db,
    close() {
      if (closed) return
      closed = true
      db.close()
      rmSync(root, { recursive: true, force: true })
    },
  }
}

/** Исполнитель для теста: по умолчанию `developer` с навыком `dev`. */
export function seedExecutor(
  db: DatabaseSync,
  input: Partial<NewExecutorInput> = {},
): Executor {
  return addExecutor(db, {
    id: input.id ?? 'developer',
    kind: input.kind ?? 'agent',
    skills: input.skills ?? ['dev'],
    runSize: input.runSize,
  })
}

export interface SeedCardInput extends Partial<NewCardInput> {
  phase?: CardPhase
  status?: CardStatus
  importance?: number | null
  urgency?: number | null
  position?: number | null
  waiveDeps?: boolean
}

/**
 * Карточка для теста: по умолчанию `UI`/`dev` от имени владельца.
 * Фазу, статус, оценки, позицию и waive_deps можно выставить напрямую:
 * createCard умеет только начальные состояния, а тестам нужны произвольные.
 */
export function seedCard(db: DatabaseSync, input: SeedCardInput = {}): Card {
  const card = createCard(db, {
    group: input.group ?? 'UI',
    title: input.title ?? 'Тестовая карточка',
    body: input.body,
    skill: input.skill ?? 'dev',
    author: input.author ?? 'owner',
  })

  const sets: string[] = []
  const params: Array<string | number | null> = []
  if (input.phase !== undefined) {
    sets.push('phase = ?')
    params.push(input.phase)
  }
  if (input.status !== undefined) {
    sets.push('status = ?')
    params.push(input.status)
  }
  if (input.importance !== undefined) {
    sets.push('importance = ?')
    params.push(input.importance)
  }
  if (input.urgency !== undefined) {
    sets.push('urgency = ?')
    params.push(input.urgency)
  }
  if (input.position !== undefined) {
    sets.push('position = ?')
    params.push(input.position)
  }
  if (input.waiveDeps !== undefined) {
    sets.push('waive_deps = ?')
    params.push(input.waiveDeps ? 1 : 0)
  }
  if (sets.length === 0) return card

  params.push(card.id)
  db.prepare(`update cards set ${sets.join(', ')} where id = ?`).run(...params)
  return getCard(db, card.id)!
}

export interface SeedRunInput {
  id?: string
  executorId?: string
  status?: RunStatus
  createdAt?: string
  startedAt?: string | null
  endedAt?: string | null
  leaseUntil?: string | null
  review?: boolean
  note?: string | null
  cardIds?: string[]
}

/**
 * Забег для теста: по умолчанию активный забег `developer` без карточек.
 * Переданные карточки бронируются так же, как это делает `startRun`.
 */
export function seedRun(db: DatabaseSync, input: SeedRunInput = {}): Run {
  const id = input.id ?? allocateId(db, 'run')
  const executorId = input.executorId ?? 'developer'
  const status = input.status ?? 'active'
  const createdAt = input.createdAt ?? nowIso()

  db.prepare(
    `insert into runs (id, executor_id, status, created_at, started_at, ended_at, lease_until, review, note)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    executorId,
    status,
    createdAt,
    input.startedAt === undefined ? createdAt : input.startedAt,
    input.endedAt ?? null,
    input.leaseUntil ?? null,
    input.review ? 1 : 0,
    input.note ?? null,
  )

  const cardIds = input.cardIds ?? []
  cardIds.forEach((cardId, index) => {
    db.prepare(
      'insert into run_cards (run_id, card_id, position, status) values (?, ?, ?, ?)',
    ).run(id, cardId, index + 1, 'booked')
    db.prepare(
      `update cards set status = 'booked', holder = ?, run_id = ?, lease_until = ?, updated_at = ?
       where id = ?`,
    ).run(executorId, id, input.leaseUntil ?? null, nowIso(), cardId)
  })

  return getRun(db, id)!
}
