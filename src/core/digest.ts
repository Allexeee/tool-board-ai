import type { DatabaseSync } from 'node:sqlite'
import { branchExists, resolveBranches, runGit } from './git/git.ts'
import { pendingRelease } from './git/release.ts'
import { UserError } from '../cli/errors.ts'

/** Риск читается словом: цвет в отчёте не переживает пайп и копирование. */
export type Risk = 'high' | 'normal' | 'low'

export const RISK_LABEL: Record<Risk, string> = {
  high: 'высокий',
  normal: 'обычный',
  low: 'низкий',
}

export interface DigestFile {
  path: string
  risk: Risk
}

export interface DigestStage {
  featureId: string
  featureName: string
  stageId: string
  stageName: string
  mergedAt: string
  risk: Risk
  files: DigestFile[]
}

// ядро очереди и миграции: ошибка здесь тихо портит данные или ход работы
const HIGH_FILES = new Set([
  'src/core/schema.ts',
  'src/core/hands.ts',
  'src/core/lease.ts',
  'src/core/power.ts',
  'src/core/runs.ts',
  'src/core/run-report.ts',
])
const HIGH_DIRS = ['src/core/git/']

const RISK_WEIGHT: Record<Risk, number> = { low: 1, normal: 2, high: 3 }

/** Риск файла по пути: миграции, git и ядро очереди — высокие, тесты — низкие. */
export function classifyRisk(path: string): Risk {
  const normalized = path.replace(/\\/g, '/')
  if (HIGH_FILES.has(normalized) || HIGH_DIRS.some((dir) => normalized.startsWith(dir))) return 'high'
  if (normalized.startsWith('tests/') || normalized.endsWith('.test.ts')) return 'low'
  return 'normal'
}

const stageRisk = (files: DigestFile[]): Risk =>
  files.reduce<Risk>((worst, file) => (RISK_WEIGHT[file.risk] > RISK_WEIGHT[worst] ? file.risk : worst), 'low')

/**
 * Коммит слияния этапа ищется по теме вида `F63.S1: ...` — так его пишет mergeStage.
 * Сначала смотрим dev против main, потом весь dev: нерелизнутый этап обязан найтись.
 */
function stageCommit(root: string, ranges: string[][], stageId: string): string | null {
  for (const range of ranges) {
    let log = ''
    try {
      log = runGit(root, ['log', ...range, '--format=%H %s'])
    } catch {
      continue
    }

    for (const line of log.split('\n')) {
      const space = line.indexOf(' ')
      if (space <= 0) continue
      if (line.slice(space + 1).startsWith(`${stageId}: `)) return line.slice(0, space)
    }
  }

  return null
}

/** Файлы этапа — разница коммита слияния с первым родителем; сортировка делает вывод устойчивым. */
function stageFiles(root: string, commit: string): string[] {
  const out = runGit(root, ['show', '--name-only', '--format=', '--first-parent', commit])
  return out
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .sort()
}

/**
 * Дайджест ревью: нерелизнутые этапы из базы, файлы каждого — из git.
 * Список даёт pendingRelease; файлы читаются по коммиту слияния в dev.
 */
export function reviewDigest(
  db: DatabaseSync,
  input: { root: string; config: { branches: { main: string; dev: string } } },
): DigestStage[] {
  const stages = pendingRelease(db)
  if (stages.length === 0) return []

  const { main, dev } = resolveBranches(input.root, input.config)
  if (!branchExists(input.root, dev)) {
    throw new UserError(3, `ветки ${dev} нет: файлы этапов читаются из git`)
  }

  const ranges: string[][] = branchExists(input.root, main) ? [[`${main}..${dev}`], [dev]] : [[dev]]

  return stages.map((stage) => {
    const commit = stageCommit(input.root, ranges, stage.stageId)
    const files = commit
      ? stageFiles(input.root, commit).map((path) => ({ path, risk: classifyRisk(path) }))
      : []

    return {
      featureId: stage.featureId,
      featureName: stage.featureName,
      stageId: stage.stageId,
      stageName: stage.stageName,
      mergedAt: stage.mergedAt,
      risk: stageRisk(files),
      files,
    }
  })
}

/** Человеческий текст: сначала что не выпущено, потом файлы с пометкой риска. */
export function formatDigest(stages: DigestStage[]): string {
  if (stages.length === 0) return 'нерелизнутых этапов нет: всё слитое в dev уже в main'

  const lines = [
    `нерелизнуто этапов: ${stages.length}`,
    'риск словом: высокий — src/core/schema.ts, src/core/git/, src/core/hands.ts, src/core/lease.ts; низкий — тесты',
  ]

  let featureId = ''
  for (const stage of stages) {
    if (stage.featureId !== featureId) {
      featureId = stage.featureId
      lines.push('', `${stage.featureId}  ${stage.featureName}`)
    }

    lines.push(`  ${stage.stageId}  ${stage.stageName} — риск: ${RISK_LABEL[stage.risk]}`)
    if (stage.files.length === 0) {
      lines.push('      файлы не найдены: коммита этапа в git нет')
      continue
    }

    for (const file of stage.files) {
      lines.push(`      ${RISK_LABEL[file.risk].padEnd(7)}  ${file.path}`)
    }
  }

  return lines.join('\n')
}
