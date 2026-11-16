import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { toolVersion } from './version.ts'

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
  branches: { main: 'main', dev: 'dev' },
  locale: 'ru',
}

export function readConfig(path: string): Config {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<Config>
  return {
    ...DEFAULT_CONFIG,
    ...raw,
    branches: { ...DEFAULT_CONFIG.branches, ...(raw.branches ?? {}) },
  }
}

export function writeConfig(path: string, config: Config): void {
  if (existsSync(path)) return
  writeFileSync(path, JSON.stringify(config, null, 2) + '\n', 'utf8')
}

