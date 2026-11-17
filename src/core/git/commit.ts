import { currentBranch, runGit } from './git.ts'
import { scopesOverlap } from './scope.ts'
import { UserError } from '../../cli/errors.ts'
import type { Task } from '../tasks.ts'

function pathspecs(task: Task): string[] {
  if (task.scope === 'exclusive') return ['.']
  // каталог без глобов git понимает как префикс; шаблону нужен glob-магик
  return task.scope.map((pattern) => (/[*?[]/.test(pattern) ? `:(glob)${pattern}` : pattern))
}

function changedFiles(worktree: string): string[] {
  const parts = [
    runGit(worktree, ['diff', '--name-only', '-z']),
    runGit(worktree, ['diff', '--cached', '--name-only', '-z']),
    runGit(worktree, ['ls-files', '--others', '--exclude-standard', '-z']),
  ]

  // -z снимает квотирование: русские имена приходят как есть
  return parts
    .flatMap((part) => part.split('\0'))
    .map((line) => line.trim())
    .filter(Boolean)
}

export function assertSafeBranch(
  worktree: string,
  options: { expected?: string | null; forbidden?: string[] } = {},
): void {
  const branch = currentBranch(worktree)

  if (!branch) {
    throw new UserError(
      3,
      'рабочий каталог в detached HEAD: коммит потеряется, переключитесь на ветку фичи',
    )
  }
  if (options.expected && branch !== options.expected) {
    throw new UserError(
      3,
      `рабочий каталог стоит на ${branch}, а задача в ветке ${options.expected}: переключитесь обратно`,
    )
  }
  if (options.forbidden?.includes(branch)) {
    throw new UserError(
      3,
      `коммит в защищённую ветку ${branch} запрещён: работайте в ветке фичи или в dev`,
    )
  }
}

/** Файлы вне области, которые коммит не тронет: их оставляем хозяину. */
export function filesOutsideScope(worktree: string, task: Task): string[] {
  if (task.scope === 'exclusive') return []
  return changedFiles(worktree).filter((path) => !scopesOverlap(task.scope, [path]))
}

function stage(worktree: string, task: Task): { specs: string[]; staged: string } {
  const specs = pathspecs(task).filter(
    (spec) => runGit(worktree, ['status', '--porcelain', '--', spec]).length > 0,
  )
  if (specs.length === 0) return { specs, staged: '' }

  runGit(worktree, ['add', '--', ...specs])
  return { specs, staged: runGit(worktree, ['diff', '--cached', '--name-only', '--', ...specs]) }
}

export function commitTask(input: {
  worktree: string
  task: Task
  report: { summary: string; checks: string[]; left?: string }
  expectedBranch?: string | null
  forbiddenBranches?: string[]
}): string | null {
  assertSafeBranch(input.worktree, {
    expected: input.expectedBranch,
    forbidden: input.forbiddenBranches,
  })

  const { specs, staged } = stage(input.worktree, input.task)
  if (!staged) return null

  const body = [input.report.summary, ...input.report.checks.map((check) => `проверено: ${check}`)]
    .filter(Boolean)
    .join('\n')

  runGit(
    input.worktree,
    ['commit', '-m', `${input.task.id}: ${input.task.title}`, '-m', body, '--', ...specs],
    { AL_ALLOW: '1' },
  )

  return runGit(input.worktree, ['rev-parse', 'HEAD'])
}

export function saveDraft(input: { worktree: string; task: Task; summary: string }): string | null {

  const { specs, staged } = stage(input.worktree, input.task)
  if (!staged) return null

  runGit(
    input.worktree,
    ['commit', '-m', `wip: ${input.task.id} ${input.summary}`, '--', ...specs],
    { AL_ALLOW: '1' },
  )

  return runGit(input.worktree, ['rev-parse', 'HEAD'])
}


