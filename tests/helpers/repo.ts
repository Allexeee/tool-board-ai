import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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

/** Коммитит сгенерированные initProject файлы (docs/board), чтобы дерево было чистым. */
export function commitGenerated(root: string, message = 'chore: board init'): void {
  git(root, ['add', '.'])
  git(root, ['commit', '-m', message])
}

/**
 * Временный источник board: два тега v1.0.0 и v1.1.0, bare-репозиторий для
 * submodule. Возвращает путь к bare, чтобы тесты не ходили в сеть.
 */
export function makeBoardSource(): { source: string; close: () => void } {
  const base = mkdtempSync(join(tmpdir(), 'board-source-'))
  const work = join(base, 'work')
  const source = join(base, 'source.git')

  execFileSync('git', ['init', '-b', 'main', work], { stdio: 'ignore', windowsHide: true })
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: work, windowsHide: true })
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: work, windowsHide: true })
  mkdirSync(join(work, 'bin'), { recursive: true })
  mkdirSync(join(work, 'src', 'core'), { recursive: true })
  const fakeCli = `import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
const args = process.argv.slice(2)
if (args[0] === 'init') {
  const file = join(process.cwd(), '.opencode', 'plugins', 'board', 'index.ts')
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, '// board ' + process.env.BOARD_TEST_VERSION + '\\n')
  const db = join(process.cwd(), '.board', 'board.db')
  mkdirSync(dirname(db), { recursive: true })
  writeFileSync(db, '')
  console.log(JSON.stringify({ root: process.cwd(), created: ['.board/board.db', '.opencode/plugins/board/index.ts'], updated: [] }))
} else {
  console.log('board')
}
`
  writeFileSync(join(work, 'bin', 'board.ts'), fakeCli)
  writeFileSync(join(work, 'src', 'core', 'now.ts'), 'export const now = true\n')
  writeFileSync(join(work, 'package.json'), JSON.stringify({ name: 'tool-board-ai', version: '1.0.0' }))

  git(work, ['add', '.'])
  git(work, ['commit', '-m', 'v1.0.0'])
  git(work, ['tag', 'v1.0.0'])

  writeFileSync(join(work, 'package.json'), JSON.stringify({ name: 'tool-board-ai', version: '1.1.0' }))
  git(work, ['add', '.'])
  git(work, ['commit', '-m', 'v1.1.0'])
  git(work, ['tag', 'v1.1.0'])

  execFileSync('git', ['init', '--bare', '--initial-branch=main', source], { stdio: 'ignore', windowsHide: true })
  git(work, ['remote', 'add', 'origin', source])
  git(work, ['push', 'origin', 'main', '--tags'])

  return {
    source,
    close() {
      rmSync(base, { recursive: true, force: true })
    },
  }
}
