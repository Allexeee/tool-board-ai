import { findProject } from '../../core/project.ts'
import { openDb } from '../../core/db.ts'
import { similarFeatures } from '../../core/templates.ts'
import { ok } from '../output.ts'
import { UserError } from '../errors.ts'

export default async function command(args: { positionals: string[] }) {
  const project = findProject(process.cwd())
  if (!project) throw new UserError(3, 'проект не найден: выполните toolbox-al init')
  const db = openDb(project.dbPath)

  const query = args.positionals.join(' ')
  if (!query) throw new UserError(3, 'использование: similar "оплата"')

  const features = similarFeatures(db, query)
  ok(
    features,
    features.length ? features.map((f) => `${f.id}  ${f.name}`).join('\n') : 'похожих фич нет',
  )
  return 0
}
