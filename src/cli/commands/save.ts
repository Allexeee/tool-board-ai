import { existsSync } from 'node:fs'
import { findProject } from '../../core/project.ts'
import { openDb } from '../../core/db.ts'
import { getTask } from '../../core/tasks.ts'
import { getStage } from '../../core/stages.ts'
import { getFeature } from '../../core/features.ts'
import { saveDraft } from '../../core/git/commit.ts'
import { stringFlag, type ParsedArgs } from '../args.ts'
import { ok } from '../output.ts'
import { UserError } from '../errors.ts'

export default async function command(args: ParsedArgs) {
  const project = findProject(process.cwd())
  if (!project) throw new UserError(3, 'проект не найден: выполните toolbox-al init')
  const db = openDb(project.dbPath)

  const taskId = args.positionals[0]
  const summary = stringFlag(args, 'summary') ?? args.positionals.slice(1).join(' ')
  if (!taskId) throw new UserError(3, 'использование: save F1.S1-1 --summary "что сделано"')

  const task = getTask(db, taskId)
  if (!task) throw new UserError(3, `задача ${taskId} не найдена`)

  const stage = task.stageId ? getStage(db, task.stageId) : null
  const feature = stage ? getFeature(db, stage.featureId) : null
  if (!feature?.worktree || !existsSync(feature.worktree)) {
    throw new UserError(3, 'у фичи нет рабочего каталога: выполните feature start')
  }

  const sha = saveDraft({ worktree: feature.worktree, task, summary })
  ok({ sha }, sha ? `черновик ${sha.slice(0, 7)}` : 'нечего сохранять')
  return 0
}
