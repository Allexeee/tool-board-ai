import { readFileSync } from 'node:fs'
import { getCard } from '../../core/cards.ts'
import { openDb } from '../../core/db.ts'
import { listDiscussion } from '../../core/discussion.ts'
import { findProject } from '../../core/project.ts'
import { listRefs, type Ref } from '../../core/refs.ts'
import {
  addFinding,
  listReviewCards,
  submitVerdict,
  type FindingInput,
} from '../../core/review.ts'
import { getRun } from '../../core/runs.ts'
import { listSteps, type Step } from '../../core/steps.ts'
import type { Card, Severity } from '../../core/types.ts'
import { stringFlag, type ParsedArgs } from '../args.ts'
import { UserError } from '../errors.ts'
import { ok } from '../output.ts'

/** Пакет ревью §9.2: всё, что нужно ревьюеру по одной карточке. */
interface ReviewItem {
  id: string
  title: string
  spec: string
  acceptance: string
  plan: Step[]
  status: Card['status']
  skill: string | null
  needsMerge: boolean
  scope: string[]
  branch: string | null
  runId: string | null
  mergeCommit: string | null
  reviewReopens: number
  reviews: Array<{
    verdict: string
    reviewer: string
    note: string | null
    at: string
    mode: string | null
    planCompliance: string | null
  }>
  findings: Array<{ id: string; title: string; severity: string | null; status: string }>
  refs: Ref[]
  discussion: ReturnType<typeof listDiscussion>
  diff: string | null
}

export default async function command(args: ParsedArgs) {
  const project = findProject(process.cwd())
  if (!project) throw new UserError(3, 'проект не найден: выполните board init')
  const db = openDb(project.dbPath)

  const list = (args: ParsedArgs): number => {
    const items: ReviewItem[] = listReviewCards(db).map((card) => {
      const steps = listSteps(db, card.id)
      const reviews = db
        .prepare(
          "select verdict, reviewer, note, at, mode, plan_compliance from reviews where card_id = ? and kind = 'run' order by id desc",
        )
        .all(card.id) as Array<{
        verdict: string
        reviewer: string
        note: string | null
        at: string
        mode: string | null
        plan_compliance: string | null
      }>
      const findings = db
        .prepare(
          "select id, title, severity, status from cards where origin_card_id = ? and status not in ('done', 'cancelled') order by id",
        )
        .all(card.id) as Array<{
        id: string
        title: string
        severity: string | null
        status: string
      }>
      return {
        id: card.id,
        title: card.title,
        spec: card.body,
        acceptance: card.acceptance,
        plan: steps,
        status: card.status,
        skill: card.skill,
        needsMerge: card.needsMerge,
        scope: card.scope,
        branch: card.branch,
        runId: card.runId,
        mergeCommit: card.mergeCommit,
        reviewReopens: card.reviewReopens,
        reviews: reviews.map((row) => ({
          verdict: row.verdict,
          reviewer: row.reviewer,
          note: row.note,
          at: row.at,
          mode: row.mode,
          planCompliance: row.plan_compliance,
        })),
        findings,
        refs: listRefs(db, card.id),
        discussion: listDiscussion(db, card.id),
        diff: card.mergeCommit ? `git diff ${card.mergeCommit}^1 ${card.mergeCommit}` : null,
      }
    })
    ok(items, formatReviewList(items))
    return 0
  }

  const finding = (args: ParsedArgs): number => {
    const cardId = args.positionals[0]
    if (!cardId) {
      throw new UserError(3, 'использование: board review finding UI-1 --severity critical --text «...»')
    }
    const severity = stringFlag(args, 'severity') as Severity | undefined
    if (!severity) throw new UserError(3, 'нужен --severity critical|important|other')
    const text = stringFlag(args, 'text')
    if (!text) throw new UserError(3, 'нужен --text «текст находки»')

    const created = addFinding(db, {
      cardId,
      reviewer: stringFlag(args, 'reviewer') ?? stringFlag(args, 'as') ?? 'owner',
      severity,
      text,
    })
    ok(created, `${created.id} создана: находка ${severity} из ревью ${cardId}`)
    return 0
  }

  const submit = (args: ParsedArgs): number => {
    const cardId = args.positionals[0]
    if (!cardId) {
      throw new UserError(
        3,
        'использование: board review submit UI-1 --verdict done|reopen --note «...» --reviewer reviewer-1 [--findings findings.json]',
      )
    }
    const verdict = stringFlag(args, 'verdict')
    if (verdict !== 'done' && verdict !== 'reopen') {
      throw new UserError(3, 'нужен --verdict done|reopen')
    }
    const reviewer = stringFlag(args, 'reviewer') ?? stringFlag(args, 'as')
    if (!reviewer) throw new UserError(3, 'нужен --reviewer <id> ревьюера')

    const planCompliance = stringFlag(args, 'plan')
    if (planCompliance !== 'done' && planCompliance !== 'failed') {
      throw new UserError(3, 'нужен --plan done|failed')
    }
    const requestedMode = stringFlag(args, 'mode')
    if (requestedMode !== undefined && requestedMode !== 'self' && requestedMode !== 'subagent') {
      throw new UserError(3, '--mode self|subagent')
    }
    const card = getCard(db, cardId)
    const run = card?.runId ? getRun(db, card.runId) : null
    const mode =
      (requestedMode as 'self' | 'subagent' | undefined) ??
      (run?.reviewMode === 'self' || run?.reviewMode === 'subagent' ? run.reviewMode : undefined)

    const findingsPath = stringFlag(args, 'findings')
    const findings = findingsPath ? parseFindings(findingsPath) : undefined

    const result = submitVerdict(db, {
      cardId,
      reviewer,
      verdict,
      note: stringFlag(args, 'note') ?? '',
      findings,
      planCompliance,
      mode,
    })
    ok(
      result,
      `${cardId} ${verdict} · plan ${planCompliance}${result.findings.length > 0 ? `; находок: ${result.findings.length}` : ''}`,
    )
    return 0
  }

  try {
    if (args.sub === 'list') return list(args)
    if (args.sub === 'finding') return finding(args)
    if (args.sub === 'submit') return submit(args)
    throw new UserError(3, 'использование: board review list|finding|submit')
  } finally {
    db.close()
  }
}

/** `findings.json`: массив `{ severity, text, skill?, scope? }` (§9.6). */
function parseFindings(path: string): FindingInput[] {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    throw new UserError(3, `файл ${path} не найден`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new UserError(3, `файл ${path}: невалидный JSON`)
  }
  if (!Array.isArray(parsed)) throw new UserError(3, `файл ${path}: ожидался массив находок`)

  return parsed.map((item, index) => {
    if (typeof item !== 'object' || item === null) {
      throw new UserError(3, `файл ${path}: находка #${index + 1} — не объект`)
    }
    const finding = item as FindingInput
    if (!finding.severity || !finding.text) {
      throw new UserError(3, `файл ${path}: у находки #${index + 1} нет severity или text`)
    }
    return finding
  })
}

function value(text: string | null): string {
  return text === null || text === '' ? '—' : text
}

function formatReviewList(items: ReviewItem[]): string {
  if (items.length === 0) return 'карточек на ревью нет'
  return items
    .map((item) => {
      const lines = [
        `${item.id} · ${item.title}`,
        `  навык: ${value(item.skill)} · мерж: ${item.needsMerge ? 'да' : 'нет'} · scope: ${item.scope.length > 0 ? item.scope.join(', ') : '—'}`,
        `  ветка: ${value(item.branch)} · merge: ${value(item.mergeCommit)}`,
        `  diff: ${item.diff ?? '—'}`,
      ]
      if (item.spec !== '') lines.push(`  spec: ${item.spec}`)
      if (item.acceptance !== '') {
        lines.push(`  acceptance: ${item.acceptance.split('\n').join(' | ')}`)
      }
      if (item.reviewReopens > 0) lines.push(`  reopens: ${item.reviewReopens}`)
      for (const review of item.reviews) {
        lines.push(`  review: ${review.verdict} · plan ${review.planCompliance ?? '—'}`)
      }
      for (const finding of item.findings) {
        lines.push(`  finding: ${finding.id} · ${finding.severity ?? '—'} · ${finding.status}`)
      }
      for (const step of item.plan) {
        lines.push(`  [${step.done ? 'x' : ' '}] ${step.seq}. ${step.text}`)
      }
      for (const ref of item.refs) {
        lines.push(`  ref ${ref.id}. ${ref.kind} ${ref.value}`)
      }
      return lines.join('\n')
    })
    .join('\n\n')
}
