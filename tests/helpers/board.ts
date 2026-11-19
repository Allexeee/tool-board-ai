import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { openDb } from '../../src/core/db.ts'
import { initProject } from '../../src/core/project.ts'

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
