import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { toolVersion } from './version.ts'
import { UserError } from '../cli/errors.ts'

export interface Config {
  toolVersion: string
  schemaVersion: number
  leaseMinutes: number
  maxAttempts: number
  handSize: number
  offlineAfterMinutes: number
  ownerStaleDays: number
  branchRetentionDays: number
  wipLimit: number
  /** Сколько рабочих каталогов держать в пуле; 0 — свой каталог на каждую фичу. */
  worktreePool: number
  branches: { main: string; dev: string }
  locale: string
}

export const DEFAULT_CONFIG: Config = {
  toolVersion: toolVersion(),
  schemaVersion: 7,
  leaseMinutes: 30,
  maxAttempts: 3,
  handSize: 5,
  offlineAfterMinutes: 120,
  ownerStaleDays: 3,
  branchRetentionDays: 30,
  wipLimit: 1,
  worktreePool: 2,
  branches: { main: 'main', dev: 'dev' },
  locale: 'ru',
}

/** Размер пула: целое не меньше нуля; мусор в конфиге читается как значение по умолчанию. */
function worktreePoolOf(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
    ? value
    : DEFAULT_CONFIG.worktreePool
}

export function readConfig(path: string): Config {
  const raw = readFileSync(path, 'utf8').replace(/^\uFEFF/, '')
  let parsed: Partial<Config>
  try {
    parsed = JSON.parse(raw) as Partial<Config>
  } catch (error) {
    throw new UserError(3, `конфиг ${path} повреждён: ${(error as Error).message}`)
  }

  return {
    ...DEFAULT_CONFIG,
    ...parsed,
    worktreePool: worktreePoolOf(parsed.worktreePool),
    branches: { ...DEFAULT_CONFIG.branches, ...(parsed.branches ?? {}) },
  }
}

/** Пишет конфиг, сохраняя BOM, если он был: иначе PowerShell снова его добавит. */
export function saveConfig(path: string, config: Record<string, unknown>): void {
  const raw = existsSync(path) ? readFileSync(path, 'utf8') : ''
  const bom = raw.startsWith('\uFEFF') ? '\uFEFF' : ''
  writeFileSync(path, bom + JSON.stringify(config, null, 2) + '\n', 'utf8')
}

export function writeConfig(path: string, config: Config): void {
  if (existsSync(path)) return
  writeFileSync(path, JSON.stringify(config, null, 2) + '\n', 'utf8')
}

