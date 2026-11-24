import type { DatabaseSync } from 'node:sqlite'
import { flushBacklog } from './backlog.ts'
import { addExecutor, getExecutor } from './executors.ts'
import { listGroups } from './groups.ts'
import { writeReviewerAgent } from './opencode.ts'
import { readSettings, updateSettings, type BoardSettings } from './settings.ts'
import {
  conflictingSkillsDisabled,
  superpowersConfigured,
} from './superpowers.ts'

export interface SetupProposal {
  defaults: {
    backlog: { path: string; auto: boolean; refreshSeconds: number }
    specReview: string
    runReview: string
    reviewer: string | null
  }
  missing: { executors: string[]; groups: boolean }
  superpowers: { configured: boolean; conflictsDisabled: boolean }
  commands: string[]
}

/** Модель текущей сессии из env плагина; невалидное значение не предлагаем. */
function sessionReviewerModel(): string | null {
  const value = process.env.BOARD_SESSION_MODEL?.trim() ?? ''
  return /^[^/\s#]+\/[^/\s#]+$/.test(value) ? value : null
}

/** Что мастер предложит после init: умолчания, чего не хватает, следующие команды. */
export function buildSetupProposal(
  db: DatabaseSync,
  root: string,
  settings: BoardSettings,
): SetupProposal {
  const groupsEmpty = listGroups(db).length === 0
  const executorMissing = getExecutor(db, 'developer') === null
  return {
    defaults: {
      backlog: { path: 'docs/board/BACKLOG.md', auto: true, refreshSeconds: 5 },
      specReview: 'auto',
      runReview: 'auto',
      reviewer: settings.reviewer.model ?? sessionReviewerModel(),
    },
    missing: {
      executors: executorMissing ? ['developer'] : [],
      groups: groupsEmpty,
    },
    superpowers: {
      configured: superpowersConfigured(root),
      conflictsDisabled: conflictingSkillsDisabled(root),
    },
    commands: [
      'board setup --defaults',
      ...(executorMissing
        ? ['board executor add developer --kind agent --skills dev --as owner']
        : []),
      ...(groupsEmpty
        ? ['board group add <PREFIX> --name <название> --as developer']
        : []),
    ],
  }
}

export interface SetupDefaultsResult {
  settings: BoardSettings
  executorCreated: boolean
  path: string | null
  error?: string
}

/**
 * Один вызов для «оставить умолчания»: бэклог вкл + 5 с, ревью auto,
 * модель ревьюера из сессии, исполнитель developer, файлы OpenCode и бэклог.
 */
export function applySetupDefaults(db: DatabaseSync, root: string): SetupDefaultsResult {
  const current = readSettings(root)
  const model = current.reviewer.model ?? sessionReviewerModel()
  const settings = updateSettings(root, {
    backlog: { auto: true, refreshSeconds: 5 },
    specReview: { mode: 'auto' },
    runReview: { mode: 'auto' },
    ...(model !== current.reviewer.model ? { reviewer: { model } } : {}),
  })

  let executorCreated = false
  if (!getExecutor(db, 'developer')) {
    addExecutor(db, { id: 'developer', kind: 'agent', skills: ['dev'] })
    executorCreated = true
  }

  writeReviewerAgent(root, settings, true)
  const flush = flushBacklog(db, root, { force: true })
  return { settings, executorCreated, path: flush.path, error: flush.error }
}
