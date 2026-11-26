import { addIdea, dropIdea, editIdea, listIdeas } from '../../core/cards.ts'
import { openDb } from '../../core/db.ts'
import { findProject } from '../../core/project.ts'
import type { Card } from '../../core/types.ts'
import { stringFlag, type ParsedArgs } from '../args.ts'
import { UserError } from '../errors.ts'
import { ok } from '../output.ts'

const USAGE =
  'board idea add "текст" [--title "..."] | list | edit <ID> [--text "..."] [--title "..."] | drop <ID>'

export default async function command(args: ParsedArgs) {
  const project = findProject(process.cwd())
  if (!project) throw new UserError(3, 'проект не найден: выполните board init')
  const db = openDb(project.dbPath)
  const actor = stringFlag(args, 'as') ?? 'owner'

  const add = (args: ParsedArgs): number => {
    const text = args.positionals.join(' ').trim()
    if (text === '') throw new UserError(3, 'нужен текст идеи')
    const card = addIdea(db, { text, title: stringFlag(args, 'title'), actor })
    ok(card, `${card.id} · идея: ${card.title}`)
    return 0
  }

  const list = (): number => {
    const ideas = listIdeas(db)
    ok(ideas, formatIdeas(ideas))
    return 0
  }

  const edit = (args: ParsedArgs): number => {
    const id = args.positionals[0]
    if (!id) throw new UserError(3, USAGE)
    const text = stringFlag(args, 'text')
    const title = stringFlag(args, 'title')
    if (text === undefined && title === undefined) {
      throw new UserError(3, 'нужен --text или --title')
    }
    const card = editIdea(db, { id, text, title, actor })
    ok(card, `${card.id} · идея обновлена: ${card.title}`)
    return 0
  }

  const drop = (args: ParsedArgs): number => {
    const id = args.positionals[0]
    if (!id) throw new UserError(3, USAGE)
    const card = dropIdea(db, { id, actor })
    ok(card, `${card.id} · идея убрана`)
    return 0
  }

  try {
    if (args.sub === 'add') return add(args)
    if (args.sub === 'list') return list()
    if (args.sub === 'edit') return edit(args)
    if (args.sub === 'drop') return drop(args)
    throw new UserError(3, USAGE)
  } finally {
    db.close()
  }
}

function formatIdeas(ideas: Card[]): string {
  if (ideas.length === 0) return 'идей нет'
  return ideas
    .map((card) => `${card.id} · ${card.title}\n  ${card.body.replace(/\r?\n/g, ' ')}`)
    .join('\n')
}
