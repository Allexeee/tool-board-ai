import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import type { Task } from './tasks.ts'
import { decisionsFor, type Decision } from './decisions.ts'
import { depsOf } from './deps.ts'
import { getStage } from './stages.ts'
import { scopesOverlap } from './git/scope.ts'
import { isRepo, runGit } from './git/git.ts'

export interface ContextFile {
  path: string
  lines: number
}

export interface ContextCommit {
  sha: string
  subject: string
}

export interface TaskContext {
  task: Task
  files: ContextFile[]
  decisions: Decision[]
  dependsOn: string[]
  commits: ContextCommit[]
  warnings: string[]
}

const SKIP = new Set(['.git', 'node_modules', '.toolbox-al', '.worktrees', 'dist', '.opencode'])

function walk(root: string, base = ''): string[] {
  const dir = join(root, base)
  const entries = readdirSync(dir, { withFileTypes: true })
  const files: string[] = []

  for (const entry of entries) {
    if (SKIP.has(entry.name)) continue
    const relative = base ? `${base}/${entry.name}` : entry.name

    if (entry.isDirectory()) {
      files.push(...walk(root, relative))
      continue
    }
    files.push(relative)
  }

  return files
}

function lineCount(path: string): number {
  try {
    if (statSync(path).size > 512 * 1024) return -1
    return readFileSync(path, 'utf8').split('\n').length
  } catch {
    return -1
  }
}

export function taskContext(db: DatabaseSync, task: Task, root: string): TaskContext {
  const warnings: string[] = []
  const files: ContextFile[] = []

  if (existsSync(root)) {
    for (const relative of walk(root)) {
      if (!scopesOverlap(task.scope, [relative])) continue
      files.push({ path: relative, lines: lineCount(join(root, relative)) })
    }
  } else {
    warnings.push(`каталог ${root} не найден: контекст без файлов`)
  }

  if (task.scope !== 'exclusive' && files.length === 0) {
    warnings.push('область не совпала ни с одним файлом: проверьте шаблоны')
  }

  const subjects = [task.id]
  if (task.stageId) {
    subjects.push(task.stageId)
    const stage = getStage(db, task.stageId)
    if (stage) subjects.push(stage.featureId)
  }

  let commits: ContextCommit[] = []
  let dependsOn: string[] = []
  try {
    dependsOn = depsOf(db, task.id)
  } catch {
    dependsOn = []
  }

  if (isRepo(root) && files.length > 0) {
    const paths = files.slice(0, 30).map((file) => file.path)
    try {
      commits = runGit(root, ['log', '-5', '--pretty=%h %s', '--', ...paths])
        .split('\n')
        .filter(Boolean)
        .map((line) => ({ sha: line.slice(0, line.indexOf(' ')), subject: line.slice(line.indexOf(' ') + 1) }))
    } catch {
      commits = []
    }
  }

  return {
    task,
    files,
    decisions: decisionsFor(db, subjects),
    dependsOn,
    commits,
    warnings,
  }
}
