import { openDb } from '../../core/db.ts'
import {
  addExecutor,
  listExecutors,
  removeExecutor,
  updateExecutor,
  type ExecutorPatch,
} from '../../core/executors.ts'
import { findProject } from '../../core/project.ts'
import type { Executor, ExecutorKind } from '../../core/types.ts'
import { numberFlag, stringFlag, stringsFlag, type ParsedArgs } from '../args.ts'
import { UserError } from '../errors.ts'
import { ok } from '../output.ts'

export default async function command(args: ParsedArgs) {
  const project = findProject(process.cwd())
  if (!project) throw new UserError(3, 'проект не найден: выполните board init')
  const db = openDb(project.dbPath)

  const add = (args: ParsedArgs): number => {
    const id = args.positionals[0]
    if (!id) throw new UserError(3, 'использование: board executor add developer --kind agent --skills dev')

    const executor = addExecutor(db, {
      id,
      kind: (stringFlag(args, 'kind') ?? 'agent') as ExecutorKind,
      skills: splitSkills(args),
      runSize: numberFlag(args, 'run-size'),
    })
    ok(executor, `${executor.id} добавлен: ${executor.skills.join(', ')} · забег до ${executor.runSize}`)
    return 0
  }

  const list = (): number => {
    const executors = listExecutors(db)
    ok(executors, executors.length === 0 ? 'исполнителей нет' : formatList(executors))
    return 0
  }

  const edit = (args: ParsedArgs): number => {
    const id = args.positionals[0]
    if (!id) throw new UserError(3, 'использование: board executor edit developer --skills dev,frontend')

    const patch: ExecutorPatch = {}
    if (args.flags['skills'] !== undefined) patch.skills = splitSkills(args)
    const runSize = numberFlag(args, 'run-size')
    if (runSize !== undefined) patch.runSize = runSize

    if (Object.keys(patch).length === 0) {
      throw new UserError(3, 'нечего менять: укажите --skills и/или --run-size')
    }

    const executor = updateExecutor(db, { id, patch })
    ok(executor, `${executor.id} изменён: ${executor.skills.join(', ')} · забег до ${executor.runSize}`)
    return 0
  }

  const remove = (args: ParsedArgs): number => {
    const id = args.positionals[0]
    if (!id) throw new UserError(3, 'использование: board executor remove developer')

    const executor = removeExecutor(db, id)
    ok({ id: executor.id }, `${executor.id} удалён`)
    return 0
  }

  try {
    if (args.sub === 'add') return add(args)
    if (args.sub === 'list') return list()
    if (args.sub === 'edit') return edit(args)
    if (args.sub === 'remove') return remove(args)
    throw new UserError(3, 'использование: board executor add|list|edit|remove')
  } finally {
    db.close()
  }
}

function splitSkills(args: ParsedArgs): string[] {
  return stringsFlag(args, 'skills').flatMap((value) => value.split(','))
}

function formatList(executors: Executor[]): string {
  return executors
    .map(
      (executor) =>
        `${executor.id.padEnd(12)} ${executor.kind.padEnd(6)} ` +
        `${executor.skills.join(', ').padEnd(20)} забег до ${executor.runSize}`,
    )
    .join('\n')
}
