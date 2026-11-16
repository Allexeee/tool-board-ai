import { findProject } from '../../core/project.ts'
import { openDb } from '../../core/db.ts'
import { addRequest, editRequest, getRequest, listRequests, mergeRequests, removeRequest, splitRequest } from '../../core/requests.ts'
import { listEvents } from '../../core/events.ts'
import { markPlansStale } from '../../core/plans.ts'
import { listFlag, stringFlag, type ParsedArgs } from '../args.ts'
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
    const body = stringFlag(args, 'body') ?? args.positionals.slice(1).join(' ')
    const request = addRequest(db, { title, body, author: actor })
    ok(request, `${request.id}  ${request.title}`)
    return 0
  }

  if (args.sub === 'edit') {
    const id = args.positionals[0]
    const title = stringFlag(args, 'title')
    const body = stringFlag(args, 'body')

    if (!id || (title === undefined && body === undefined)) {
      throw new UserError(3, 'использование: request edit R3 --title "..." --body "..."')
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

    const lines = [`${request.id}  ${request.title}`, `статус: ${request.status}`, '', request.body]

    if (args.flags.history === true) {
      const history = listEvents(db, { subject: request.id }).filter(
        (event) => event.type === 'request.edited',
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
    }

    ok(request, lines.join('\n'))
    return 0
  }

  const requests = listRequests(db)
  ok(
    requests,
    requests.length === 0
      ? 'запросов нет'
      : requests.map((r) => `${r.id.padEnd(5)} ${r.status.padEnd(8)} ${r.title}`).join('\n'),
  )
  return 0
}
