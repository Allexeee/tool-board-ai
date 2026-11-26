import { openDb } from '../../core/db.ts'
import { findProject } from '../../core/project.ts'
import { addTag, listTags, removeTag, renameTag, type Tag } from '../../core/tags.ts'
import { stringFlag, type ParsedArgs } from '../args.ts'
import { UserError } from '../errors.ts'
import { ok } from '../output.ts'

const USAGE =
  'board tag add <name> [--description "..."] | list | rename <old> <new> | remove <name>'

export default async function command(args: ParsedArgs) {
  const project = findProject(process.cwd())
  if (!project) throw new UserError(3, 'проект не найден: выполните board init')
  const db = openDb(project.dbPath)
  const actor = stringFlag(args, 'as') ?? 'owner'

  const add = (args: ParsedArgs): number => {
    const name = args.positionals[0]
    if (!name) throw new UserError(3, USAGE)
    const tag = addTag(db, { name, description: stringFlag(args, 'description'), actor })
    ok(tag, `${tag.name} добавлен${tag.description ? ': ' + tag.description : ''}`)
    return 0
  }

  const list = (): number => {
    const tags = listTags(db)
    ok(tags, formatTags(tags))
    return 0
  }

  const rename = (args: ParsedArgs): number => {
    const [from, to] = args.positionals
    if (!from || !to) throw new UserError(3, USAGE)
    const tag = renameTag(db, { from, to, actor })
    ok(tag, `${from} → ${tag.name}`)
    return 0
  }

  const remove = (args: ParsedArgs): number => {
    const name = args.positionals[0]
    if (!name) throw new UserError(3, USAGE)
    const tag = removeTag(db, { name, actor })
    ok(tag, `${tag.name} удалён`)
    return 0
  }

  try {
    if (args.sub === 'add') return add(args)
    if (args.sub === 'list') return list()
    if (args.sub === 'rename') return rename(args)
    if (args.sub === 'remove') return remove(args)
    throw new UserError(3, USAGE)
  } finally {
    db.close()
  }
}

function formatTags(tags: Tag[]): string {
  if (tags.length === 0) return 'тегов нет'
  return tags
    .map((tag) => `${tag.name} · карточек ${tag.count}${tag.description ? ` · ${tag.description}` : ''}`)
    .join('\n')
}
