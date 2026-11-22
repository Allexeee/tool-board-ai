import { findProject } from '../../core/project.ts'
import { initProject } from '../../core/project.ts'
import {
  boardSubmoduleSource,
  checkoutBoardRef,
  currentBoardVersion,
  latestBoardTag,
} from '../../core/git.ts'
import { boolFlag, type ParsedArgs } from '../args.ts'
import { UserError } from '../errors.ts'
import { ok } from '../output.ts'

export default async function command(args: ParsedArgs) {
  const project = findProject(process.cwd())
  if (!project) throw new UserError(3, 'проект не найден: выполните board init')

  const explicit = args.positionals[0]
  const latest = boolFlag(args, 'latest')
  if (explicit && latest) throw new UserError(3, 'укажите ref или --latest, но не оба')

  const source = boardSubmoduleSource(project.root)
  if (latest && !source) throw new UserError(2, 'tools/board не submodule: выполните board init')
  const ref = explicit ?? (latest ? latestBoardTag(source!) : null)
  if (!ref) throw new UserError(3, 'использование: board upgrade <ref>|--latest [--allow-downgrade]')

  checkoutBoardRef(project.root, ref, { allowDowngrade: boolFlag(args, 'allow-downgrade') })
  const result = initProject(project.root, { refresh: true })

  ok(
    {
      root: project.root,
      ref,
      boardVersion: currentBoardVersion(project.root),
      created: result.created,
      updated: result.updated,
    },
    `tools/board → ${ref} (${currentBoardVersion(project.root) ?? '?'})\n` +
      `Создано: ${result.created.length}, обновлено: ${result.updated.length}`,
  )
  return 0
}
