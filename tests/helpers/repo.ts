import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }).trim()
}

export function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'tbal-repo-'))
  execFileSync('git', ['init', '-b', 'main', dir], { stdio: 'ignore', windowsHide: true })
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir, windowsHide: true })
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir, windowsHide: true })
  writeFileSync(join(dir, 'README.md'), '# repo\n')
  execFileSync('git', ['add', '.'], { cwd: dir, windowsHide: true })
  execFileSync('git', ['commit', '-m', 'init'], { cwd: dir, stdio: 'ignore', windowsHide: true })
  return dir
}

export function makeRepoWithDev(): string {
  const dir = makeRepo()
  execFileSync('git', ['branch', 'dev'], { cwd: dir, windowsHide: true })
  return dir
}
