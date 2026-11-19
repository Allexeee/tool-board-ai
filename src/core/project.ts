import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { openDb } from './db.ts'
import { writeOpenCodeFiles } from './opencode.ts'
import { ensureSettings } from './settings.ts'
import { ensureTerminology } from './terminology.ts'

export interface Project {
  root: string
  dbPath: string
  docsDir: string
  boardDir: string
}

function projectAt(root: string): Project | null {
  const dbPath = join(root, '.board', 'board.db')
  if (!existsSync(dbPath)) return null

  return {
    root,
    dbPath,
    boardDir: join(root, '.board'),
    docsDir: join(root, 'docs', 'board'),
  }
}

/**
 * Ищет `.board/board.db` вверх по дереву. BOARD_HOME перекрывает поиск.
 * Worktree лежит внутри `<root>/.worktrees/<id>`, поэтому обход находит
 * основной каталог сам: отдельной базы в worktree нет.
 */
export function findProject(
  startDir: string,
  env: NodeJS.ProcessEnv = process.env,
): Project | null {
  const home = env.BOARD_HOME?.trim()
  if (home) return projectAt(resolve(home))

  let dir = resolve(startDir)
  for (;;) {
    const project = projectAt(dir)
    if (project) return project

    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

const GITIGNORE_ENTRIES = ['.board/', '.worktrees/']

function updateGitignore(root: string): boolean {
  const path = join(root, '.gitignore')
  const current = existsSync(path) ? readFileSync(path, 'utf8') : ''
  const lines = current.split(/\r?\n/)
  const missing = GITIGNORE_ENTRIES.filter((entry) => !lines.includes(entry))
  if (missing.length === 0) return false

  if (current !== '' && !current.endsWith('\n')) appendFileSync(path, '\n')
  appendFileSync(path, missing.join('\n') + '\n')
  return true
}

function stripToolboxBlock(text: string): string {
  const lines = text.split(/\r?\n/)
  const kept: string[] = []
  let inBlock = false
  let inLegacy = false

  for (const line of lines) {
    if (/^\s*#\s*toolbox-al:begin\b/.test(line)) {
      inBlock = true
      continue
    }
    if (inBlock) {
      if (/^\s*#\s*toolbox-al:end\b/.test(line)) inBlock = false
      continue
    }
    // старый формат без маркеров: маркер и тело до exit 0
    if (/^\s*#\s*toolbox-al:\s*protect main and dev\b/.test(line)) {
      inLegacy = true
      continue
    }
    if (inLegacy) {
      if (/^\s*exit 0\s*$/.test(line)) inLegacy = false
      continue
    }
    if (/^\s*#\s*toolbox-al\b/.test(line)) continue
    kept.push(line)
  }

  return kept.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n'
}

function hasHookBody(text: string): boolean {
  return text
    .split(/\r?\n/)
    .some((line) => line.trim() !== '' && !line.trim().startsWith('#!'))
}

function stripToolboxHook(root: string): void {
  const path = join(root, '.git', 'hooks', 'pre-commit')
  if (!existsSync(path)) return

  const current = readFileSync(path, 'utf8')
  if (!current.includes('toolbox-al')) return

  const next = stripToolboxBlock(current)
  if (hasHookBody(next)) {
    writeFileSync(path, next)
  } else {
    rmSync(path, { force: true })
  }
}

export function initProject(dir: string): { created: string[]; root: string } {
  const root = resolve(dir)
  const created: string[] = []

  const boardDir = join(root, '.board')
  if (!existsSync(boardDir)) {
    mkdirSync(boardDir, { recursive: true })
    created.push('.board/')
  }

  const docsDir = join(root, 'docs', 'board')
  if (!existsSync(docsDir)) {
    mkdirSync(docsDir, { recursive: true })
    created.push('docs/board/')
  }

  const dbPath = join(boardDir, 'board.db')
  if (!existsSync(dbPath)) created.push('.board/board.db')

  if (!existsSync(join(docsDir, 'terminology.md'))) {
    ensureTerminology(root)
    created.push('docs/board/terminology.md')
  }

  if (ensureSettings(root).created) created.push('.board/settings.json')

  const db = openDb(dbPath)
  try {
    db.prepare(
      "insert or ignore into executors (id, kind, skills) values ('owner', 'human', '[\"owner\"]')",
    ).run()
  } finally {
    db.close()
  }

  if (updateGitignore(root)) created.push('.gitignore')

  created.push(...writeOpenCodeFiles(root).created)

  // Новый хук не ставим: доска не защищает ветки.
  stripToolboxHook(root)

  return { created, root }
}
