import { findProject } from '../../core/project.ts'
import { openDb } from '../../core/db.ts'
import { doneTask } from '../../core/done.ts'
import { getTask } from '../../core/tasks.ts'
import { getStage } from '../../core/stages.ts'
import { getFeature } from '../../core/features.ts'
import { commitTask } from '../../core/git/commit.ts'
import { existsSync } from 'node:fs'
import { listFlag, stringFlag, type ParsedArgs } from '../args.ts'
import { ok } from '../output.ts'
import { UserError } from '../errors.ts'

export default async function command(args: ParsedArgs) {
  const project = findProject(process.cwd())
  if (!project) throw new UserError(3, 'проект не найден: выполните toolbox-al init')
  const db = openDb(project.dbPath)

  const taskId = args.positionals[0]
  const executor = stringFlag(args, 'as')
  const summary = stringFlag(args, 'summary') ?? args.positionals.slice(1).join(' ')

  if (!taskId || !executor) {
    throw new UserError(3, 'использование: done F1.S1-1 --as w1 --summary "что сделано" --checks "npm test"')
  }

  const before = getTask(db, taskId)
  const stage = before?.stageId ? getStage(db, before.stageId) : null
  const feature = stage ? getFeature(db, stage.featureId) : null
  if (before && feature?.worktree && existsSync(feature.worktree)) {
    commitTask({ worktree: feature.worktree, task: before, report: { summary, checks: listFlag(args, 'checks'), left: stringFlag(args, 'left') } })
  }

  const task = doneTask(db, {
    taskId,
    executor,
    report: {
      summary,
      checks: listFlag(args, 'checks'),
      left: stringFlag(args, 'left'),
    },
  })

  ok(task, `${task.id}  закрыта`)
  return 0
}
