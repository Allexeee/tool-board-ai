import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { openDb } from './db.ts'
import { DEFAULT_CONFIG, readConfig, writeConfig, type Config } from './config.ts'
import { installHooks } from './git/hooks.ts'
import { writeOpenCodeFiles } from './opencode.ts'

export interface Project {
  root: string
  dbPath: string
  configPath: string
  config: Config
}

export function findProject(startDir: string): Project | null {
  let dir = resolve(startDir)

  for (;;) {
    const configPath = join(dir, '.toolbox-al', 'config.json')
    if (existsSync(configPath)) {
      return {
        root: dir,
        dbPath: join(dir, '.toolbox-al', 'tracker.db'),
        configPath,
        config: readConfig(configPath),
      }
    }
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

export function initProject(dir: string): { created: string[]; root: string } {
  const root = resolve(dir)
  const alDir = join(root, '.toolbox-al')
  const created: string[] = []

  if (!existsSync(alDir)) {
    mkdirSync(alDir, { recursive: true })
    created.push('.toolbox-al/')
  }

  const configPath = join(alDir, 'config.json')
  const hadConfig = existsSync(configPath)
  writeConfig(configPath, DEFAULT_CONFIG)
  if (!hadConfig) created.push('.toolbox-al/config.json')

  const dbPath = join(alDir, 'tracker.db')
  if (!existsSync(dbPath)) {
    openDb(dbPath).close()
    created.push('.toolbox-al/tracker.db')
  }

  if (existsSync(join(root, '.git'))) {
    installHooks(join(root, '.git'), { protectedBranches: ['main', 'dev'] })
  }

  const opencode = writeOpenCodeFiles(root, DEFAULT_CONFIG.toolVersion)
  created.push(...opencode.created)

  const gitignore = join(root, '.gitignore')
  const entries = ['.toolbox-al/', '.worktrees/']
  const current = existsSync(gitignore) ? readFileSync(gitignore, 'utf8') : ''
  const missing = entries.filter((entry) => !current.split(/\r?\n/).includes(entry))
  if (missing.length > 0) {
    if (current && !current.endsWith('\n')) appendFileSync(gitignore, '\n')
    appendFileSync(gitignore, missing.join('\n') + '\n')
    created.push('.gitignore')
  }

  return { created, root }
}
