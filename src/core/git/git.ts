import { execFileSync } from 'node:child_process'
import { UserError } from '../../cli/errors.ts'

export class GitError extends UserError {
  constructor(message: string) {
    super(3, message)
    this.name = 'GitError'
  }
}

export function runGit(cwd: string, args: string[], env: Record<string, string> = {}): string {
  try {
    return execFileSync('git', args, {
      cwd,
      windowsHide: true,
      encoding: 'utf8',
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim()
  } catch (error) {
    const stderr = String((error as { stderr?: unknown }).stderr ?? '')
    if (/not a git repository/i.test(stderr)) {
      throw new GitError(`не git-репозиторий: ${cwd}`)
    }
    throw new GitError(stderr.trim() || String((error as Error).message))
  }
}

export function isRepo(dir: string): boolean {
  try {
    return runGit(dir, ['rev-parse', '--is-inside-work-tree']) === 'true'
  } catch {
    return false
  }
}

export function currentBranch(dir: string): string | null {
  try {
    return runGit(dir, ['symbolic-ref', '--short', 'HEAD'])
  } catch {
    return null
  }
}

export function branchExists(dir: string, name: string): boolean {
  try {
    return runGit(dir, ['branch', '--list', name]).trim().length > 0
  } catch {
    return false
  }
}

export function resolveBranches(
  dir: string,
  config: { branches: { main: string; dev: string } },
): { main: string; dev: string } {
  const main = config.branches.main
  let dev = config.branches.dev

  if (!branchExists(dir, dev) && branchExists(dir, 'develop')) dev = 'develop'

  return { main, dev }
}
