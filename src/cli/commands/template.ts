import { findProject } from '../../core/project.ts'
import { openDb } from '../../core/db.ts'
import { listTemplates, saveTemplate, showTemplate } from '../../core/templates.ts'
import { stringFlag, type ParsedArgs } from '../args.ts'
import { ok } from '../output.ts'
import { UserError } from '../errors.ts'

export default async function command(args: ParsedArgs) {
  const project = findProject(process.cwd())
  if (!project) throw new UserError(3, 'проект не найден: выполните toolbox-al init')
  const db = openDb(project.dbPath)

  if (args.sub === 'save') {
    const name = args.positionals[0]
    const featureId = stringFlag(args, 'from')
    if (!name || !featureId) throw new UserError(3, 'использование: template save content-pack --from F1')
    const path = saveTemplate(project.root, { name, featureId, db })
    ok({ name, path }, `шаблон ${name} сохранён`)
    return 0
  }

  if (args.sub === 'show') {
    const name = args.positionals[0]
    if (!name) throw new UserError(3, 'использование: template show content-pack')
    const text = showTemplate(project.root, name)
    ok({ name, text }, text)
    return 0
  }

  const names = listTemplates(project.root)
  ok(names, names.length ? names.join('\n') : 'шаблонов нет')
  return 0
}
