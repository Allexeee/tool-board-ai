import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { addExecutor, type NewExecutorInput } from '../../src/core/executors.ts'
import { createCard, type NewCardInput } from '../../src/core/cards.ts'
import { openDb } from '../../src/core/db.ts'
import { initProject } from '../../src/core/project.ts'
import type { Card, Executor } from '../../src/core/types.ts'

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

/** Карточка для теста: по умолчанию `UI`/`dev` от имени владельца. */
export function seedCard(db: DatabaseSync, input: Partial<NewCardInput> = {}): Card {
  return createCard(db, {
    group: input.group ?? 'UI',
    title: input.title ?? 'Тестовая карточка',
    body: input.body,
    skill: input.skill ?? 'dev',
    author: input.author ?? 'owner',
  })
}
