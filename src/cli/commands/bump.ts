import { findProject } from '../../core/project.ts'
import { bumpVersion, type BumpKind } from '../../core/version.ts'
import type { ParsedArgs } from '../args.ts'
import { UserError } from '../errors.ts'
import { ok } from '../output.ts'

const USAGE = 'board bump patch|minor|major'

export default async function command(args: ParsedArgs) {
  const project = findProject(process.cwd())
  if (!project) throw new UserError(3, 'проект не найден: выполните board init')
  const kind = args.positionals[0] as BumpKind | undefined
  if (kind !== 'patch' && kind !== 'minor' && kind !== 'major') {
    throw new UserError(3, USAGE)
  }

  const result = bumpVersion(project.root, kind)
  ok(result, `${result.from} → ${result.to}`)
  return 0
}
