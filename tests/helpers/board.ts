import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { addExecutor, type NewExecutorInput } from '../../src/core/executors.ts'
import { createCard, getCard, type NewCardInput } from '../../src/core/cards.ts'
import { openDb } from '../../src/core/db.ts'
import { initProject } from '../../src/core/project.ts'
import type { Card, CardPhase, CardStatus, Executor } from '../../src/core/types.ts'

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
  waiveDeps?: boolean
}

/**
 * Карточка для теста: по умолчанию `UI`/`dev` от имени владельца.
 * Фазу, статус и waive_deps можно выставить напрямую: createCard умеет только
 * начальные состояния, а тестам нужны произвольные.
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
  const params: Array<string | number> = []
  if (input.phase !== undefined) {
    sets.push('phase = ?')
    params.push(input.phase)
  }
  if (input.status !== undefined) {
    sets.push('status = ?')
    params.push(input.status)
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
