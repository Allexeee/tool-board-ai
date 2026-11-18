import { findProject } from '../../core/project.ts'
import { openDb } from '../../core/db.ts'
import { addRequest, closeKind, closeRequest, editRequest, landState, getRequest, listRequests, laterRequest, openRequests, mergeRequests, removeRequest, reopenRequest, splitRequest } from '../../core/requests.ts'
import { listEvents } from '../../core/events.ts'
import { listFeatures } from '../../core/features.ts'
import { getQuestions } from '../../core/questions.ts'
import { listDecisions } from '../../core/decisions.ts'
import { markPlansStale } from '../../core/plans.ts'
import { boolFlag, listFlag, stringFlag, textFileFlag, type ParsedArgs } from '../args.ts'
import { ok } from '../output.ts'
import { UserError } from '../errors.ts'

export default async function command(args: ParsedArgs) {
  const project = findProject(process.cwd())
  if (!project) throw new UserError(3, 'проект не найден: выполните toolbox-al init')
  const db = openDb(project.dbPath)

  const actor = stringFlag(args, 'as') ?? 'owner'

  if (args.sub === 'add') {
    const title = args.positionals[0] ?? stringFlag(args, 'title')
    if (!title) throw new UserError(3, 'не указан заголовок запроса')
    const positionalBody = args.positionals.slice(1).join(' ')
    const body = textFileFlag(args, 'body', { positional: positionalBody }) ?? stringFlag(args, 'body') ?? positionalBody
    const request = addRequest(db, { title, body, author: actor })
    ok(request, `${request.id}  ${request.title}`)
    return 0
  }

  if (args.sub === 'close') {
    const id = args.positionals[0]
    const reason = stringFlag(args, 'reason')
    if (!id || !reason) {
      throw new UserError(3, 'использование: request close R20 --reason "почему закрыт"')
    }

    const request = closeRequest(db, {
      id,
      reason,
      kind: stringFlag(args, 'kind') as 'done' | 'cancelled' | undefined,
      actor,
    })
    ok(request, `${request.id} закрыт`)
    return 0
  }

  if (args.sub === 'edit') {
    const id = args.positionals[0]
    const title = stringFlag(args, 'title')
    const body = textFileFlag(args, 'body') ?? stringFlag(args, 'body')

    if (!id || (title === undefined && body === undefined)) {
      throw new UserError(3, 'использование: request edit R3 --title "..." --body "..." | --text-file <файл|->')
    }

    const request = editRequest(db, { id, title, body, actor })
    const stale = markPlansStale(db, { requestId: id, actor })
    ok(
      request,
      `${request.id}  ${request.title}${stale > 0 ? '\nутверждённый план помечен устаревшим' : ''}`,
    )
    return 0
  }

  if (args.sub === 'merge') {
    const from = args.positionals[0]
    const to = args.positionals[1]
    if (!from || !to) throw new UserError(3, 'использование: request merge R2 R1 — R2 вливается в R1')

    const request = mergeRequests(db, { from, to, actor })
    ok(request, `${from} объединён с ${to}`)
    return 0
  }

  if (args.sub === 'split') {
    const id = args.positionals[0]
    const into = listFlag(args, 'into')
    if (!id || into.length === 0) {
      throw new UserError(3, 'использование: request split R3 --into "часть 1" --into "часть 2"')
    }

    const created = splitRequest(db, { id, into, actor })
    ok(created, created.map((request) => `${request.id}  ${request.title}`).join('\n'))
    return 0
  }

  if (args.sub === 'later') {
    const id = args.positionals[0]
    const until = stringFlag(args, 'until') ?? args.positionals[1]
    if (!id || !until) throw new UserError(3, 'использование: request later R3 --until 2026-12-01')

    const request = laterRequest(db, { id, until, actor })
    ok(request, `${request.id} отложен до ${request.reviewAt}`)
    return 0
  }

  if (args.sub === 'reopen') {
    const id = args.positionals[0]
    if (!id) throw new UserError(3, 'использование: request reopen R3')

    const request = reopenRequest(db, { id, actor })
    ok(request, `${request.id} снова в inbox`)
    return 0
  }

  if (args.sub === 'remove') {
    const id = args.positionals[0]
    if (!id) throw new UserError(3, 'использование: request remove R3')
    removeRequest(db, { id, actor })
    ok({ id }, `${id} удалён`)
    return 0
  }

  if (args.sub === 'show') {
    const request = getRequest(db, args.positionals[0] ?? '')
    if (!request) throw new UserError(3, 'запрос не найден')

    const features = listFeatures(db).filter((feature) => feature.requestId === request.id)
    const questions = getQuestions(db, { status: 'pending' }).filter(
      (question) => question.subjectId === request.id,
    )
    const decisions = listDecisions(db, { subjectId: request.id })
    const allEvents = listEvents(db, { subject: request.id })
    const history = allEvents.filter((event) => event.type === 'request.edited')
    const closedEvent = allEvents.filter((event) => event.type === 'request.closed').at(-1)

    const lines = [`${request.id}  ${request.title}`, `статус: ${request.status}`]
    if (request.reviewAt) lines.push(`пересмотр: ${request.reviewAt}`)
    if (closedEvent?.note) lines.push(`закрыт: ${closedEvent.note}`)
    const land = landState(db, request.id)
    if (land) lines.push(`залито: ${land}`)
    lines.push('', request.body)

    lines.push('', '## Фичи')
    lines.push(
      features.length === 0
        ? 'нет'
        : features.map((feature) => `- ${feature.id} [${feature.status}] ${feature.name}`).join('\n'),
    )

    lines.push('', '## Вопросы')
    lines.push(
      questions.length === 0
        ? 'нет'
        : questions.map((question) => `- ${question.id}: ${question.text}`).join('\n'),
    )

    lines.push('', '## Решения')
    lines.push(
      decisions.length === 0
        ? 'нет'
        : decisions.map((decision) => `- ${decision.id}: ${decision.question} → ${decision.choice}`).join('\n'),
    )

    lines.push('', '## История')
    if (history.length === 0) {
      lines.push('изменений нет')
    } else {
      for (const event of history) {
        const before = event.before ? (JSON.parse(event.before) as { title: string; body: string }) : null
        const after = event.after ? (JSON.parse(event.after) as { title: string; body: string }) : null
        lines.push(`${event.at}  ${event.actor}`)
        if (before) lines.push(`  было: ${before.title} · ${before.body}`)
        if (after) lines.push(`  стало: ${after.title} · ${after.body}`)
      }
    }

    ok(request, lines.join('\n'))
    return 0
  }

  if (args.sub === 'open') {
    const brief = boolFlag(args, 'brief')
    const requests = openRequests(db)
    ok(
      requests,
      requests.length === 0
        ? 'открытых запросов нет'
        : requests
            .map((r) =>
              brief
                ? `${r.id.padEnd(5)} ${r.status}`
                : `${r.id.padEnd(5)} ${r.status.padEnd(8)} ${r.title}`,
            )
            .join('\n'),
    )
    return 0
  }

  const requests = listRequests(db)
  ok(
    requests,
    requests.length === 0
      ? 'запросов нет'
      : requests
          .map((r) => {
            const parts: string[] = []
            // статус в базе может отставать: запрос закрыт, когда закрыты все его фичи
            const land = landState(db, r.id)
            const status = r.status !== 'closed' && land !== null ? 'closed' : r.status
            const kind = r.status === 'closed' ? closeKind(db, r.id) : null
            if (kind) parts.push(kind === 'merged' ? 'объединён' : kind)
            if (land) parts.push(land)

            const suffix = parts.length > 0 ? `  (${parts.join(' · ')})` : ''
            const review = r.reviewAt ? ` · до ${r.reviewAt}` : ''
            return `${r.id.padEnd(5)} ${status.padEnd(8)} ${r.title}${suffix}${review}`
          })
          .join('\n'),
  )
  return 0
}



