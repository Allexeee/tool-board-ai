import { findProject } from '../../core/project.ts'
import { openDb } from '../../core/db.ts'
import { addIdea, editIdea, listIdeas, promoteIdea, realizeIdea, removeIdea } from '../../core/ideas.ts'
import { boolFlag, stringFlag, textFileFlag, type ParsedArgs } from '../args.ts'
import { ok } from '../output.ts'
import { UserError } from '../errors.ts'

export default async function command(args: ParsedArgs) {
  const project = findProject(process.cwd())
  if (!project) throw new UserError(3, 'проект не найден: выполните toolbox-al init')
  const db = openDb(project.dbPath)

  if (args.sub === 'add') {
    const positional = args.positionals[0]
    const text = textFileFlag(args, 'text', { positional }) ?? positional ?? stringFlag(args, 'text')
    if (!text) throw new UserError(3, 'использование: idea add "текст" | idea add --text-file <файл|->')
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

  if (args.sub === 'edit') {
    const id = args.positionals[0]
    if (!id) throw new UserError(3, 'использование: idea edit I1 --text "…" | --text-file <файл|->  [--deadline 2026-12-01]')

    const idea = editIdea(db, {
      ideaId: id,
      text: textFileFlag(args) ?? stringFlag(args, 'text'),
      reviewAt: args.flags.deadline === undefined ? undefined : String(args.flags.deadline),
      actor: 'owner',
    })
    ok(idea, `${idea.id}  ${idea.text}`)
    return 0
  }

  if (args.sub === 'remove') {
    const id = args.positionals[0]
    if (!id) throw new UserError(3, 'использование: idea remove I1')
    removeIdea(db, { ideaId: id, actor: 'owner' })
    ok({ id }, `${id} удалена`)
    return 0
  }

  if (args.sub === 'realize') {
    const id = args.positionals[0]
    if (!id) throw new UserError(3, 'использование: idea realize I1 --note "как реализована"')
    const idea = realizeIdea(db, {
      ideaId: id,
      actor: 'owner',
      note: stringFlag(args, 'note'),
    })
    ok(idea, `${idea.id} отмечена реализованной`)
    return 0
  }

  const ideas = listIdeas(db, { all: boolFlag(args, 'all') })
  ok(
    ideas,
    ideas.length === 0
      ? 'идей нет'
      : ideas
          .map((idea) => {
            const review = idea.reviewAt ? `  (до ${idea.reviewAt})` : ''
            return `${idea.id.padEnd(4)} ${idea.promotedTo ? '→ ' + idea.promotedTo : '  '} ${idea.text}${review}`
          })
          .join('\n'),
  )
  return 0
}

