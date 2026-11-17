import type { DatabaseSync } from 'node:sqlite'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { UserError } from '../cli/errors.ts'
import { featureCost, type FeatureCost } from './cost.ts'
import { listDecisions, type Decision } from './decisions.ts'
import { ownerHand, type OwnerItem } from './questions.ts'
import { pendingRelease } from './git/release.ts'
import { countAssignments, type AssignCounts } from './views.ts'
import {
  getRunRecord,
  reviewOf,
  reviewState,
  type RunRecord,
  type RunReview,
  type RunReviewState,
} from './runs.ts'

// ─── отчёт прогона: то, что владелец читает утром ────────────────────────────
//
// Не пересказ чата, а факты из базы: что уже в dev, что ждёт залития и во
// сколько обошлось, что требует решения владельца и какие допущения взяты.

export interface MergedStageRow {
  featureId: string
  featureName: string
  stageId: string
  stageName: string
  mergedAt: string
}

export interface PendingFeature {
  featureId: string
  featureName: string
  stages: string[]
  cost: FeatureCost
}

export interface RunReportData {
  run: RunRecord
  state: RunReviewState
  review: RunReview | null
  /** Сделано в прогоне: этапы, слитые в dev, пока прогон шёл. */
  merged: MergedStageRow[]
  /** Ждёт залития в main, с ценой по каждой фиче. */
  pending: PendingFeature[]
  /** Что ждёт владельца: задачи, вопросы, этапы. */
  waitingOwner: OwnerItem[]
  /** Взятые по ходу допущения: решения по фичам прогона. */
  assumptions: Decision[]
  /** Как выдавались задачи за прогон: раздачей, руками, взятием без выдачи. */
  assignment: AssignCounts
}

export interface RunReport extends RunReportData {
  path: string
}

const MODE_TEXT = { plan: 'по плану', all: 'доталово' } as const
const POWER_TEXT = { none: 'не трогать', hibernate: 'гибернация', shutdown: 'выключение' } as const
const REASON_TEXT = { owner: 'владелец', tasks: 'задачи', decision: 'решение' } as const
const REVIEW_TEXT: Record<RunReviewState, string | null> = {
  open: null,
  not_required: 'ревью не было',
  needs_review: 'нужно ревью',
  found: 'ревью нашло замечания',
  ready: 'готов к релизу',
}

function stamp(iso: string): string {
  const at = new Date(iso)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${pad(at.getDate())}.${pad(at.getMonth() + 1)}.${at.getFullYear()} ${pad(at.getHours())}:${pad(at.getMinutes())}`
}

/** Дата в имени файла — та же, что владелец видит в шапке: местная, не UTC. */
function day(iso: string): string {
  const at = new Date(iso)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`
}

/** Этапы, слитые в dev, пока шёл прогон: от старта до конца (или до сейчас). */
function mergedInRun(db: DatabaseSync, run: RunRecord, now: Date): MergedStageRow[] {
  const to = run.endedAt ?? now.toISOString()

  return db
    .prepare(
      'select f.id as featureId, f.name as featureName, s.id as stageId, s.name as stageName, ' +
        's.merged_at as mergedAt ' +
        'from stages s join features f on f.id = s.feature_id ' +
        "where s.status = 'merged' and s.merged_at is not null " +
        'and s.merged_at >= ? and s.merged_at <= ? ' +
        'order by s.merged_at, s.id',
    )
    .all(run.startedAt, to) as unknown as MergedStageRow[]
}

/** Ожидание main: этапы по фичам, цена считается один раз на фичу. */
function pendingByFeature(db: DatabaseSync): PendingFeature[] {
  const groups = new Map<string, { featureId: string; featureName: string; stages: string[] }>()

  for (const stage of pendingRelease(db)) {
    const group = groups.get(stage.featureId) ?? {
      featureId: stage.featureId,
      featureName: stage.featureName,
      stages: [],
    }
    group.stages.push(`${stage.stageId} «${stage.stageName}»`)
    groups.set(stage.featureId, group)
  }

  return [...groups.values()].map((group) => ({ ...group, cost: featureCost(db, group.featureId) }))
}

/** Допущения — решения по фичам, которых коснулся прогон. */
function assumptionsOf(db: DatabaseSync, featureIds: string[]): Decision[] {
  const seen = new Set<string>()
  const decisions: Decision[] = []

  for (const featureId of featureIds) {
    for (const decision of listDecisions(db, { subjectId: featureId })) {
      if (seen.has(decision.id)) continue
      seen.add(decision.id)
      decisions.push(decision)
    }
  }

  return decisions.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
}

export function collectRunReport(
  db: DatabaseSync,
  runId: string,
  options: { now?: Date } = {},
): RunReportData {
  const run = getRunRecord(db, runId)
  if (!run) throw new UserError(3, `прогон ${runId} не найден`)

  // отчёт — про закрытый прогон: пока он идёт, «сделано» меняется каждую минуту,
  // а питание сработало бы по бумаге без всего, что слилось после
  if (!run.endedAt) {
    throw new UserError(
      1,
      `прогон ${run.id} ещё идёт: отчёт пишется по закрытому прогону, сначала run end ${run.id}`,
    )
  }

  const now = options.now ?? new Date()
  const review = reviewOf(db, run.id)
  const merged = mergedInRun(db, run, now)
  const pending = pendingByFeature(db)
  const to = run.endedAt ?? now.toISOString()

  const featureIds = [...new Set([...merged.map((row) => row.featureId), ...pending.map((row) => row.featureId)])]

  return {
    run,
    state: reviewState(run, review),
    review,
    merged,
    pending,
    waitingOwner: ownerHand(db),
    assumptions: assumptionsOf(db, featureIds),
    // как задачи попадали в руки за прогон: тот же срез, что владелец видит в now
    assignment: countAssignments(db, { since: run.startedAt, until: to }),
  }
}

function costText(cost: FeatureCost): string {
  // этап без задач — не «0 из 0», а честное «задач нет»
  if (cost.tasks === 0) return 'задач нет'

  const parts = [
    `задач ${cost.tasks} (закрыто ${cost.done}${cost.deferred ? `, отложено ${cost.deferred}` : ''})`,
    `правок ${cost.edits}`,
    `переоткрытий ${cost.reopens}`,
    `блоков ${cost.blocks}`,
  ]
  if (cost.hours > 0) parts.push(`${cost.hours} ч`)
  return parts.join(' · ')
}

function ownerLine(item: OwnerItem): string {
  if (item.kind === 'question') {
    const question = item.item as { text: string; deadline?: string | null }
    const deadline = question.deadline ? ` (срок ${stamp(question.deadline)})` : ''
    return `- вопрос ${item.id}: «${question.text}»${deadline}`
  }
  if (item.kind === 'task') {
    const task = item.item as { title: string; status: string }
    return `- задача ${item.id}: «${task.title}» (${task.status})`
  }
  const stage = item.item as { name: string; status: string }
  return `- этап ${item.id}: «${stage.name}» (${stage.status})`
}

/**
 * Текст отчёта. Пустые разделы не печатаются: отчёт пустого прогона — это
 * шапка с чем стартовали, а не четыре заголовка без строк.
 */
export function renderRunReport(report: RunReportData): string {
  const { run } = report
  const requests = run.requests.length > 0 ? run.requests.join(', ') : 'не выбраны'
  const head = [
    `# Прогон ${run.id}`,
    '',
    `- режим: ${MODE_TEXT[run.mode]}${run.nearest ? ' (плюс ближайшие запросы)' : ''}`,
    `- запросы: ${requests}`,
    `- утверждение начального плана: ${run.approve ? 'да' : 'нет'}`,
    `- питание после прогона: ${POWER_TEXT[run.power]}`,
    `- раздача: dispatch ${report.assignment.dispatch} · руками ${report.assignment.hand} · ` +
      `без выдачи ${report.assignment.take}`,
    `- начат: ${stamp(run.startedAt)}`,
  ]

  if (run.endedAt) {
    head.push(`- закрыт: ${stamp(run.endedAt)}`)
    const review = REVIEW_TEXT[report.state]
    const reason = run.endReason ? REASON_TEXT[run.endReason] ?? run.endReason : 'не указана'
    head.push(`- конец: ${reason}${review ? ' · ' + review : ''}`)
  }

  if (report.review?.note) head.push(`- замечания ревью: ${report.review.note}`)

  const blocks: string[] = [head.join('\n')]

  if (report.merged.length > 0) {
    blocks.push(
      [
        '## Сделано',
        '',
        ...report.merged.map(
          (row) =>
            `- ${row.stageId} «${row.stageName}» (фича ${row.featureId} «${row.featureName}»), ` +
            `слит в dev ${stamp(row.mergedAt)}`,
        ),
      ].join('\n'),
    )
  }

  if (report.pending.length > 0) {
    blocks.push(
      [
        '## Ждёт залития в main',
        '',
        ...report.pending.map(
          (row) =>
            `- ${row.featureId} «${row.featureName}»: этапы ${row.stages.join(', ')} · ${costText(row.cost)}`,
        ),
      ].join('\n'),
    )
  }

  if (report.waitingOwner.length > 0) {
    blocks.push(['## Нужны решения владельца', '', ...report.waitingOwner.map(ownerLine)].join('\n'))
  }

  if (report.assumptions.length > 0) {
    blocks.push(
      [
        '## Взятые допущения',
        '',
        ...report.assumptions.map(
          (decision) =>
            `- ${decision.id} «${decision.question}» → «${decision.choice}»` +
            ` (почему: ${decision.reason}; автор ${decision.author}, ${stamp(decision.createdAt)})`,
        ),
      ].join('\n'),
    )
  }

  return blocks.join('\n\n') + '\n'
}

/**
 * Отчёт пишется файлом до питания: владелец читает его утром, а не ищет в
 * чате. Только по закрытому прогону — это проверяет collectRunReport.
 */
export function writeRunReport(
  db: DatabaseSync,
  runId: string,
  options: { root: string; now?: Date },
): RunReport {
  const report = collectRunReport(db, runId, options)
  const dir = join(options.root, '.toolbox-al', 'reports')
  const path = join(dir, `${report.run.id}-${day(report.run.startedAt)}.md`)

  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, renderRunReport(report), 'utf8')

  return { ...report, path }
}
