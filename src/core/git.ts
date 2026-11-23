import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { UserError } from '../cli/errors.ts'
import { nowIso } from './clock.ts'
import { readSettings } from './settings.ts'
import { scopeAllows } from './scope.ts'
import type { Card } from './types.ts'

/** Ошибка git-команды хранит код выхода: он нужен `isAncestor`. */
class GitCommandError extends Error {
  status: number | null

  constructor(message: string, status: number | null) {
    super(message)
    this.name = 'GitCommandError'
    this.status = status
  }
}

/**
 * Одна точка входа в git. `AL_ALLOW=1` ставится всем командам, чтобы старый
 * хук не мог блокировать мержи в dev/main; `env` перекрывает значение.
 */
export function runGit(cwd: string, args: string[], env: Record<string, string> = {}): string {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      env: { ...process.env, AL_ALLOW: '1', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    }).trim()
  } catch (error) {
    const err = error as { status?: number | null; stderr?: unknown; message?: string }
    const stderr = typeof err.stderr === 'string' ? err.stderr : String(err.stderr ?? '')
    throw new GitCommandError(stderr.trim() || err.message || 'git failed', err.status ?? null)
  }
}

export function isRepo(dir: string): boolean {
  try {
    return runGit(dir, ['rev-parse', '--is-inside-work-tree']) === 'true'
  } catch {
    return false
  }
}

/**
 * Репозиторий самого board: имя пакета и собственные bin/ + src/core/now.ts.
 * Нужен, чтобы `init` не добавлял репозиторий сам себе submodule.
 */
export function isBoardSourceRepo(root: string): boolean {
  const pkg = join(root, 'package.json')
  if (!existsSync(pkg) || !existsSync(join(root, 'bin', 'board.ts'))) return false
  if (!existsSync(join(root, 'src', 'core', 'now.ts'))) return false
  try {
    const parsed = JSON.parse(readFileSync(pkg, 'utf8')) as { name?: unknown }
    return parsed.name === 'tool-board-ai'
  } catch {
    return false
  }
}

/** Локальный CLI проекта: tools/board, затем bin/board.ts у самого board. */
export function findLocalBoardCli(root: string): string | null {
  const vendored = join(root, 'tools', 'board', 'bin', 'board.ts')
  if (existsSync(vendored)) return vendored
  if (isBoardSourceRepo(root)) return join(root, 'bin', 'board.ts')
  return null
}

/**
 * Корень проекта для диспетчера. Worktree в `<root>/.worktrees/<id>` имеет
 * собственный `.git`, но версия board живёт в корне: поднимаемся выше.
 */
export function findProjectRootForCli(startDir: string): string | null {
  let dir = resolve(startDir)
  for (;;) {
    if (existsSync(join(dir, '.board'))) return dir
    if (existsSync(join(dir, '.git'))) {
      return basename(dirname(dir)) === '.worktrees' ? dirname(dirname(dir)) : dir
    }
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

export type BoardSubmoduleState =
  | 'missing'
  | 'not-initialized'
  | 'not-submodule'
  | 'dirty'
  | 'ready'

const BOARD_SUBMODULE = 'tools/board'

function versionParts(tag: string): number[] {
  return tag.replace(/^v/, '').split('.').map((part) => Number(part) || 0)
}

function compareVersions(left: string, right: string): number {
  const a = versionParts(left)
  const b = versionParts(right)
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    const diff = (a[index] ?? 0) - (b[index] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

/** Последний semver-тег источника; сеть нужна только здесь. */
export function latestBoardTag(source: string): string {
  const output = runGit(process.cwd(), ['ls-remote', '--tags', '--refs', source])
  const tags = output
    .split('\n')
    .map((line) => line.split('\t')[1] ?? '')
    .map((ref) => ref.replace(/^refs\/tags\//, ''))
    .filter((tag) => /^v\d+\.\d+\.\d+$/.test(tag))
  if (tags.length === 0) throw new UserError(2, `в ${source} нет тегов vX.Y.Z`)
  return tags.sort(compareVersions).at(-1)!
}

export function currentBoardVersion(root: string): string | null {
  const pkg = join(root, BOARD_SUBMODULE, 'package.json')
  if (!existsSync(pkg)) return null
  try {
    return (JSON.parse(readFileSync(pkg, 'utf8')) as { version?: string }).version ?? null
  } catch {
    return null
  }
}

/** URL submodule из .gitmodules: нужен для `upgrade --latest`. */
export function boardSubmoduleSource(root: string): string | null {
  const modules = join(root, '.gitmodules')
  if (!existsSync(modules)) return null
  const text = readFileSync(modules, 'utf8')
  const section = text.match(/\[submodule "tools\/board"\]([\s\S]*?)(?=\n\[|$)/)
  const url = section?.[1].match(/^\s*url\s*=\s*(.+)$/m)
  return url?.[1]?.trim() ?? null
}

export function boardSubmoduleState(root: string): BoardSubmoduleState {
  const dir = join(root, BOARD_SUBMODULE)
  const modules = join(root, '.gitmodules')
  const registered =
    existsSync(modules) && readFileSync(modules, 'utf8').includes(`path = ${BOARD_SUBMODULE}`)

  if (!existsSync(dir)) return registered ? 'not-initialized' : 'missing'
  if (!registered) return 'not-submodule'
  if (!existsSync(join(dir, '.git'))) return 'not-initialized'
  try {
    if (runGit(dir, ['status', '--porcelain']) !== '') return 'dirty'
  } catch {
    return 'not-initialized'
  }
  return 'ready'
}

export function addBoardSubmodule(root: string, source: string, ref: string): void {
  const dir = join(root, BOARD_SUBMODULE)
  if (existsSync(dir)) throw new UserError(3, `${BOARD_SUBMODULE} уже существует`)
  if (!isRepo(root)) throw new UserError(3, 'нужен git-репозиторий')
  runGit(root, ['-c', 'protocol.file.allow=always', 'submodule', 'add', source, BOARD_SUBMODULE])
  runGit(dir, ['checkout', ref])
}

function versionAt(dir: string, ref: string): string | null {
  try {
    const raw = runGit(dir, ['show', `${ref}:package.json`])
    return (JSON.parse(raw) as { version?: string }).version ?? null
  } catch {
    return null
  }
}

/** Переключает submodule на ref; даунгрейд — только с allowDowngrade. */
export function checkoutBoardRef(
  root: string,
  ref: string,
  options: { allowDowngrade?: boolean } = {},
): void {
  const dir = join(root, BOARD_SUBMODULE)
  const state = boardSubmoduleState(root)
  if (state === 'missing' || state === 'not-initialized') {
    throw new UserError(2, 'board не установлен: выполните board init')
  }
  if (state === 'dirty') {
    throw new UserError(2, `рабочее дерево ${BOARD_SUBMODULE} грязное: закоммитьте или откатите изменения`)
  }
  if (state !== 'ready') throw new UserError(2, `submodule ${BOARD_SUBMODULE}: ${state}`)

  runGit(dir, ['fetch', '--tags', '--quiet'])
  const current = currentBoardVersion(root)
  const target = versionAt(dir, ref)
  if (current && target && compareVersions(target, current) < 0 && !options.allowDowngrade) {
    throw new UserError(
      2,
      `даунгрейд ${current} → ${target} требует --allow-downgrade: схема базы может быть новее`,
    )
  }
  runGit(dir, ['checkout', ref])
}

/**
 * Ветки §7.1: из настроек, иначе по git — `main`/`master` и `dev`/`develop`.
 * Проект с другими именами настраивает их через `board setup --branch-main/--branch-dev`.
 */
export function resolveBranches(root: string): { main: string; dev: string } {
  let explicit: { main: string | null; dev: string | null } | null = null
  try {
    explicit = readSettings(root).branches
  } catch {
    explicit = null
  }
  const main = explicit?.main ?? detectBranch(root, ['main', 'master']) ?? 'main'
  const dev = explicit?.dev ?? detectBranch(root, ['dev', 'develop']) ?? 'dev'
  return { main, dev }
}

function detectBranch(root: string, candidates: string[]): string | null {
  for (const name of candidates) {
    if (branchExists(root, name)) return name
  }
  return null
}

export function currentBranch(dir: string): string | null {
  try {
    return runGit(dir, ['symbolic-ref', '--short', 'HEAD'])
  } catch {
    return null
  }
}

function branchExists(dir: string, name: string): boolean {
  try {
    runGit(dir, ['rev-parse', '--verify', '--quiet', `refs/heads/${name}`])
    return true
  } catch {
    return false
  }
}

const normalizePath = (value: string): string => resolve(value).replace(/\\/g, '/').toLowerCase()

/** Каталог числится за git рабочим каталогом: его можно переиспользовать. */
function isRegisteredWorktree(root: string, dir: string): boolean {
  const wanted = normalizePath(dir)
  return runGit(root, ['worktree', 'list', '--porcelain'])
    .split('\n')
    .filter((line) => line.startsWith('worktree '))
    .some((line) => normalizePath(line.slice('worktree '.length).trim()) === wanted)
}

/** Файлы с конфликтом слияния, если оно в процессе. */
function listUnmerged(cwd: string): string[] {
  try {
    return runGit(cwd, ['diff', '--name-only', '--diff-filter=U'])
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
  } catch {
    return []
  }
}

function requireClean(root: string): void {
  if (runGit(root, ['status', '--porcelain']) !== '') {
    throw new UserError(
      3,
      `рабочее дерево ${root} грязное: сначала закоммитьте или откатите изменения`,
    )
  }
}

/**
 * Переключает основной worktree на `target`, выполняет `action` (merge или
 * revert), записывает HEAD и возвращает исходную ветку. Конфликт прерывает
 * действие и возвращает исходную ветку.
 */
function onBranch(
  root: string,
  target: string,
  action: () => void,
  abort: () => void,
  conflictLabel: string,
): string {
  requireClean(root)
  const original = currentBranch(root)

  try {
    runGit(root, ['checkout', target])
    action()
  } catch (error) {
    const conflicted = listUnmerged(root)
    try {
      abort()
    } catch {
      // не конфликт: сообщаем исходную ошибку, но ветку всё равно возвращаем
      if (original && original !== target) {
        try {
          runGit(root, ['checkout', original])
        } catch {
          /* ветку вернуть не удалось — оставляем как есть */
        }
      }
      throw error
    }
    if (original && original !== target) {
      try {
        runGit(root, ['checkout', original])
      } catch {
        /* ветку вернуть не удалось — оставляем как есть */
      }
    }
    throw new UserError(3, `${conflictLabel}: ${conflicted.join(', ') || 'без списка файлов'}`)
  }

  const commit = runGit(root, ['rev-parse', 'HEAD'])
  if (original && original !== target) runGit(root, ['checkout', original])
  return commit
}

/**
 * Worktree исполнителя `.worktrees/<id>`: создаётся от `dev` лениво,
 * переиспользуется, если уже зарегистрирован. Каталог, который git не знает,
 * не затираем — это может быть чужая работа.
 */
export function ensureWorktree(root: string, executorId: string): string {
  if (!isRepo(root)) throw new UserError(3, `не git-репозиторий: ${root}`)

  const { dev } = resolveBranches(root)
  const worktree = join(root, '.worktrees', executorId)

  if (existsSync(worktree)) {
    if (!isRegisteredWorktree(root, worktree)) {
      throw new UserError(
        3,
        `каталог ${worktree} занят посторонними файлами: git его не знает`,
      )
    }
    return worktree
  }

  mkdirSync(join(root, '.worktrees'), { recursive: true })
  runGit(root, ['worktree', 'prune'])
  runGit(root, ['worktree', 'add', worktree, dev])
  return worktree
}

/**
 * Берёт карточку в работу: worktree переключается на ветку карточки.
 * Ветка `card/<ID>` для первой попытки, `card/<ID>-<attempt>` для следующих.
 */
export function startCardBranch(
  root: string,
  executorId: string,
  card: Card,
): { branch: string; worktree: string } {
  const worktree = ensureWorktree(root, executorId)
  const { dev } = resolveBranches(root)
  const branch = card.attempt > 1 ? `card/${card.id}-${card.attempt}` : `card/${card.id}`

  if (runGit(worktree, ['status', '--porcelain']) !== '') {
    throw new UserError(
      3,
      `рабочее дерево ${worktree} грязное: сначала закоммитьте или откатите изменения`,
    )
  }

  if (branchExists(root, branch)) {
    runGit(worktree, ['checkout', branch])
  } else {
    runGit(worktree, ['checkout', '-b', branch, dev])
  }

  return { branch, worktree }
}

/** Подтягивает `dev` в ветку карточки; конфликт прерывается и пробрасывается. */
export function syncWithDev(root: string, worktree: string, branch: string): void {
  const { dev } = resolveBranches(root)

  try {
    runGit(worktree, ['merge', dev])
  } catch (error) {
    const conflicted = listUnmerged(worktree)
    try {
      runGit(worktree, ['merge', '--abort'])
    } catch {
      throw error
    }
    throw new UserError(
      3,
      `конфликт слияния ${dev} в ${branch}: ${conflicted.join(', ') || 'без списка файлов'}`,
    )
  }
}

/** Изменённые относительно `dev` файлы ветки, которые выходят за `scope`. */
export function outOfScope(root: string, branch: string, scope: string[]): string[] {
  const { dev } = resolveBranches(root)
  return runGit(root, ['diff', '--name-only', `${dev}...${branch}`])
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((path) => !scopeAllows(path, scope))
}

/** Мержит ветку карточки в `dev` без fast-forward; возвращает merge-коммит. */
export function mergeToDev(root: string, branch: string, message: string): string {
  if (!isRepo(root)) throw new UserError(3, `не git-репозиторий: ${root}`)
  const { dev } = resolveBranches(root)

  return onBranch(
    root,
    dev,
    () => runGit(root, ['merge', '--no-ff', branch, '-m', message]),
    () => runGit(root, ['merge', '--abort']),
    `конфликт слияния ${branch} в ${dev}`,
  )
}

export function isAncestor(root: string, commit: string, ref: string): boolean {
  try {
    runGit(root, ['merge-base', '--is-ancestor', commit, ref])
    return true
  } catch (error) {
    if (error instanceof GitCommandError && error.status === 1) return false
    throw error
  }
}

/**
 * Пересчитывает кэш `in_dev`/`in_main` из git (§7.3): merge-коммит является
 * предком `dev`/`main`? Без merge-коммита оба флага сбрасываются. Значения
 * кэшируются в карточке; git остаётся источником истины.
 */
export function refreshMergeState(db: DatabaseSync, root: string, card: Card): Card {
  const { main, dev } = resolveBranches(root)
  const inDev = card.mergeCommit !== null && isAncestor(root, card.mergeCommit, dev)
  const inMain = card.mergeCommit !== null && isAncestor(root, card.mergeCommit, main)
  const at = nowIso()

  db.prepare('update cards set in_dev = ?, in_main = ?, updated_at = ? where id = ?').run(
    inDev ? 1 : 0,
    inMain ? 1 : 0,
    at,
    card.id,
  )

  return { ...card, inDev, inMain, updatedAt: at }
}

/**
 * Merge-коммит ветки в `dev`, если он есть; иначе null. Ищем по родителю:
 * merge-коммит, чей список родителей содержит кончик ветки, — именно тот,
 * что влил эту ветку. Новее в диапазоне не подходит: при нескольких мержах
 * он может принадлежать другой карточке.
 */
export function mergeCommitFor(root: string, branch: string): string | null {
  const { dev } = resolveBranches(root)

  let tip: string
  try {
    tip = runGit(root, ['rev-parse', branch])
  } catch {
    return null
  }

  const lines = runGit(root, ['log', '--merges', '--format=%H %P', dev])
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)

  for (const line of lines) {
    const [hash, ...parents] = line.split(/\s+/)
    if (parents.includes(tip)) return hash
  }

  return null
}

/** Откатывает влитую карточку revert-коммитом в `dev`; возвращает его. */
export function revertMerge(root: string, mergeCommit: string): string {
  if (!isRepo(root)) throw new UserError(3, `не git-репозиторий: ${root}`)
  const { dev } = resolveBranches(root)

  return onBranch(
    root,
    dev,
    () => runGit(root, ['revert', '-m', '1', '--no-edit', mergeCommit]),
    () => runGit(root, ['revert', '--abort']),
    `конфликт revert ${mergeCommit}`,
  )
}

/** Тег релиза `v<версия>`: ставится один раз, повторный release не падает. */
export function tagRelease(root: string, version: string): boolean {
  const tag = `v${version}`
  try {
    runGit(root, ['rev-parse', '--verify', '--quiet', `refs/tags/${tag}`])
    return false
  } catch {
    // тега ещё нет — ставим ниже
  }
  runGit(root, ['tag', '-a', tag, '-m', `release ${tag}`])
  return true
}

/** Мержит `dev` в `main` без fast-forward; возвращает release-коммит. */
export function releaseToMain(root: string): string {
  if (!isRepo(root)) throw new UserError(3, `не git-репозиторий: ${root}`)
  const { main, dev } = resolveBranches(root)

  return onBranch(
    root,
    main,
    () => runGit(root, ['merge', '--no-ff', dev, '-m', 'release']),
    () => runGit(root, ['merge', '--abort']),
    `конфликт слияния ${dev} в ${main}`,
  )
}
