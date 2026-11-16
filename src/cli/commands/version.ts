import { findProject } from '../../core/project.ts'
import { openDb } from '../../core/db.ts'
import { availableVersions, pinnedVersion, schemaVersion, toolVersion } from '../../core/upgrade.ts'
import { ok } from '../output.ts'
import { UserError } from '../errors.ts'

export default async function command() {
  const project = findProject(process.cwd())
  if (!project) throw new UserError(3, 'проект не найден: выполните toolbox-al init')
  const db = openDb(project.dbPath, { allowOutdated: true })

  const tool = toolVersion()
  const schema = schemaVersion(db)
  const pinned = pinnedVersion(db) ?? project.config.toolVersion
  const available = availableVersions()

  const data = { tool, schema, pinned, available, outdated: pinned !== tool }

  ok(
    data,
    [
      `toolbox-al ${tool}  ·  схема ${schema}`,
      `проект закреплён на ${pinned}`,
      available.length ? `доступно: ${available.slice(0, 5).join(', ')}` : 'доступных версий нет: нет git-тегов',
      data.outdated ? 'проект отстаёт от установленного инструмента' : 'совпадает с установленным',
    ].join('\n'),
  )
  return 0
}
