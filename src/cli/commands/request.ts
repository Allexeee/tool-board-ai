import { findProject } from '../../core/project.ts'
import { openDb } from '../../core/db.ts'
import { addRequest, getRequest, listRequests } from '../../core/requests.ts'
import { stringFlag, type ParsedArgs } from '../args.ts'
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

  if (args.sub === 'show') {
    const request = getRequest(db, args.positionals[0] ?? '')
    if (!request) throw new UserError(3, 'запрос не найден')
    ok(request, `${request.id}  ${request.title}\nстатус: ${request.status}\n\n${request.body}`)
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
