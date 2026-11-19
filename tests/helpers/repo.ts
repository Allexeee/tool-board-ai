import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export interface RepoFixture {
  root: string
  close: () => void
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  }).trim()
}

/**
 * Временный git-репозиторий: ветка `main` с коммитом и ветка `dev` на том же
 * коммите. `.worktrees/` и `.board/` в `.gitignore`, чтобы worktree не грязнил
 * `git status` основного каталога.
 */
export function makeRepo(): RepoFixture {
  const root = mkdtempSync(join(tmpdir(), 'board-repo-'))
  execFileSync('git', ['init', '-b', 'main', root], { stdio: 'ignore', windowsHide: true })
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root, windowsHide: true })
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root, windowsHide: true })

  writeFileSync(join(root, '.gitignore'), '.worktrees/\n.board/\n')
  writeFileSync(join(root, 'README.md'), '# repo\n')
  git(root, ['add', '.'])
  git(root, ['commit', '-m', 'init'])
  git(root, ['branch', 'dev'])

  return {
    root,
    close() {
      rmSync(root, { recursive: true, force: true })
    },
  }
}
