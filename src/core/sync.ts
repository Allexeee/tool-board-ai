import { copyFileSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { UserError } from '../cli/errors.ts'
import { runGit } from './git.ts'

/** Рабочий клон приватного репозитория данных внутри проекта. */
export const SYNC_DIR = join('.board', 'sync')
const SYNC_DB = 'board.db'

function syncPath(root: string): string {
  return join(root, SYNC_DIR)
}

function requireRemote(remote: string | null): string {
  if (!remote) {
    throw new UserError(3, 'sync не настроен: board setup --sync <git-url приватного репозитория>')
  }
  return remote
}

/** Клонирует приватный репозиторий данных или обновляет его origin. */
function ensureRepo(root: string, remote: string): string {
  const dir = syncPath(root)
  mkdirSync(join(root, '.board'), { recursive: true })
  if (!existsSync(join(dir, '.git'))) {
    runGit(root, ['-c', 'protocol.file.allow=always', 'clone', remote, dir])
  } else {
    runGit(dir, ['remote', 'set-url', 'origin', remote])
  }
  return dir
}

/**
 * Копия базы в приватный git: коммит и push. Вызывается после закрытия базы —
 * CLI делает checkpoint WAL до вызова.
 */
export function syncPush(
  root: string,
  dbPath: string,
  remote: string | null,
): { path: string; changed: boolean } {
  const url = requireRemote(remote)
  const dir = ensureRepo(root, url)

  copyFileSync(dbPath, join(dir, SYNC_DB))
  runGit(dir, ['add', SYNC_DB])
  const changed = runGit(dir, ['status', '--porcelain']) !== ''
  if (changed) {
    runGit(dir, ['-c', 'user.name=board', '-c', 'user.email=board@local', 'commit', '-m', 'board snapshot'])
  }
  runGit(dir, ['push', 'origin', 'HEAD'])
  return { path: join(dir, SYNC_DB), changed }
}

/**
 * Обновление локальной базы из приватного git. Перед заменой делает копию
 * `.pre-pull`; одновременно писать с двух машин нельзя — last-write-wins.
 */
export function syncPull(root: string, dbPath: string, remote: string | null): { backup: string | null } {
  const url = requireRemote(remote)
  const dir = ensureRepo(root, url)

  runGit(dir, ['fetch', 'origin'])
  runGit(dir, ['checkout', 'FETCH_HEAD', '--', SYNC_DB])

  let backup: string | null = null
  if (existsSync(dbPath)) {
    backup = `${dbPath}.pre-pull-${Date.now()}`
    copyFileSync(dbPath, backup)
  }
  // Старый WAL от прежней базы не должен примениться к новой.
  for (const suffix of ['-wal', '-shm']) rmSync(dbPath + suffix, { force: true })
  copyFileSync(join(dir, SYNC_DB), dbPath)
  return { backup }
}
