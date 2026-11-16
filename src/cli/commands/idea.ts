import { findProject } from '../../core/project.ts'
import { openDb } from '../../core/db.ts'
import { addIdea, listIdeas, promoteIdea } from '../../core/ideas.ts'
import { stringFlag, type ParsedArgs } from '../args.ts'
import { ok } from '../output.ts'
import { UserError } from '../errors.ts'

export default async function command(args: ParsedArgs) {
  const project = findProject(process.cwd())
  if (!project) throw new UserError(3, 'проект не найден: выполните toolbox-al init')
  const db = openDb(project.dbPath)

  if (args.sub === 'add') {
    const text = args.positionals[0] ?? stringFlag(args, 'text')
    if (!text) throw new UserError(3, 'использование: idea add "текст"')
    const idea = addIdea(db, { text, reviewAt: stringFlag(args, 'deadline') })
    ok(idea, `${idea.id}  ${idea.text}`)
    return 0
  }

  if (args.sub === 'promote') {
    const id = args.positionals[0]
    if (!id) throw new UserError(3, 'использование: idea promote I1')
    const { request } = promoteIdea(db, { ideaId: id, author: 'owner' })
    ok(request, `${id} → ${request.id}  ${request.title}`)
    return 0
  }

  const ideas = listIdeas(db)
  ok(
    ideas,
    ideas.length === 0
      ? 'идей нет'
      : ideas.map((idea) => `${idea.id.padEnd(4)} ${idea.promotedTo ? '→ ' + idea.promotedTo : '  '} ${idea.text}`).join('\n'),
  )
  return 0
}
