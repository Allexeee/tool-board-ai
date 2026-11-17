import { findProject } from '../../core/project.ts'
import { openDb } from '../../core/db.ts'
import { doneTask } from '../../core/done.ts'
import { getTask } from '../../core/tasks.ts'
import { getStage } from '../../core/stages.ts'
import { getFeature } from '../../core/features.ts'
import { commitTask } from '../../core/git/commit.ts'
import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { advanceTime } from '../../core/clock.ts'
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
  if (!before) throw new UserError(3, `задача ${taskId} не найдена`)
  advanceTime(db)
  const task = getTask(db, taskId)!
  if (task.holder !== executor) throw new UserError(3, `задача ${task.id} не у исполнителя ${executor}`)
  if (task.status !== 'active') throw new UserError(1, `задача ${task.id} не в работе: ${task.status}`)
  if (!summary.trim()) throw new UserError(3, 'нужен отчёт: --summary "что сделано"')

  const stage = task.stageId ? getStage(db, task.stageId) : null
  const feature = stage ? getFeature(db, stage.featureId) : null

  if (feature && !feature.worktree) {
    throw new UserError(3, `у фичи ${feature.id} нет рабочего каталога: выполните feature start`)
  }

  if (task.checkCmd) {
    const result =
      process.platform === 'win32'
        ? spawnSync('cmd.exe', ['/c', task.checkCmd], { cwd: feature?.worktree ?? project.root, encoding: 'utf8' })
        : spawnSync('sh', ['-c', task.checkCmd], { cwd: feature?.worktree ?? project.root, encoding: 'utf8' })
    if (result.status !== 0) {
      throw new UserError(
        3,
        `проверка DoD не прошла: ${task.checkCmd}\n${String(result.stdout ?? '')}${String(result.stderr ?? '')}`,
      )
    }
  }

  if (task.stageId) {
    if (!feature?.worktree) {
      throw new UserError(3, `у фичи ${feature?.id ?? '?'} нет рабочего каталога: выполните feature start`)
    }
    if (!existsSync(feature.worktree)) {
      throw new UserError(3, `рабочий каталог фичи ${feature.id} пропал: выполните feature start`)
    }
    commitTask({
      worktree: feature.worktree,
      task,
      report: { summary, checks: listFlag(args, 'checks'), left: stringFlag(args, 'left') },
      expectedBranch: feature.branch,
    })
  } else {
    commitTask({
      worktree: project.root,
      task,
      report: { summary, checks: listFlag(args, 'checks'), left: stringFlag(args, 'left') },
      forbiddenBranches: [project.config.branches.main],
    })
  }

  const closed = doneTask(db, {
    taskId,
    executor,
    report: {
      summary,
      checks: listFlag(args, 'checks'),
      left: stringFlag(args, 'left'),
    },
  })

  ok(closed, `${closed.id}  ${closed.status === 'in_review' ? 'на ревью' : 'закрыта'}`)
  return 0
}
