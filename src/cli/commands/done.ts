import { findProject } from '../../core/project.ts'
import { openDb } from '../../core/db.ts'
import { doneTask } from '../../core/done.ts'
import { getTask } from '../../core/tasks.ts'
import { getStage } from '../../core/stages.ts'
import { getFeature } from '../../core/features.ts'
import { commitTask, filesOutsideScope } from '../../core/git/commit.ts'
import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { advanceTime } from '../../core/clock.ts'
import { lastSnapshot } from '../../core/lease.ts'
import { boolFlag, listFlag, stringFlag, type ParsedArgs } from '../args.ts'
import { ok } from '../output.ts'
import { UserError } from '../errors.ts'

function isToolFile(path: string): boolean {
  const normalized = path.replace(/\\\\/g, '/')
  return (
    normalized === 'AGENTS.md' ||
    normalized === '.gitignore' ||
    normalized.startsWith('.toolbox-al/') ||
    normalized.startsWith('.worktrees/') ||
    normalized.startsWith('.opencode/')
  )
}

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
        ? spawnSync('cmd.exe', ['/c', task.checkCmd], { cwd: feature?.worktree ?? project.root, encoding: 'utf8', windowsHide: true })
        : spawnSync('sh', ['-c', task.checkCmd], { cwd: feature?.worktree ?? project.root, encoding: 'utf8', windowsHide: true })
    if (result.status !== 0) {
      throw new UserError(
        3,
        `проверка DoD не прошла: ${task.checkCmd}\n${String(result.stdout ?? '')}${String(result.stderr ?? '')}`,
      )
    }
  }

  const worktreeForScope = feature?.worktree ?? project.root
  const outside = existsSync(worktreeForScope)
    ? filesOutsideScope(worktreeForScope, task).filter((path) => !isToolFile(path))
    : []
  if (outside.length > 0 && !boolFlag(args, 'force-outside')) {
    throw new UserError(
      2,
      `правки вне области ${task.id} останутся незакоммиченными: ${outside.join(', ')}. ` +
        'Добавьте их в область или повторите с --force-outside',
    )
  }

  let commit: string | null = null

  if (task.stageId) {
    if (!feature?.worktree) {
      throw new UserError(3, `у фичи ${feature?.id ?? '?'} нет рабочего каталога: выполните feature start`)
    }
    if (!existsSync(feature.worktree)) {
      throw new UserError(3, `рабочий каталог фичи ${feature.id} пропал: выполните feature start`)
    }
    commit = commitTask({
      worktree: feature.worktree,
      task,
      report: { summary, checks: listFlag(args, 'checks'), left: stringFlag(args, 'left') },
      expectedBranch: feature.branch,
      limitTo: task.scope === 'exclusive' ? (lastSnapshot(db, task.id) ?? undefined) : undefined,
    })
  } else {
    commit = commitTask({
      worktree: project.root,
      task,
      report: { summary, checks: listFlag(args, 'checks'), left: stringFlag(args, 'left') },
      forbiddenBranches: [project.config.branches.main],
      limitTo: task.scope === 'exclusive' ? (lastSnapshot(db, task.id) ?? undefined) : undefined,
    })
  }

  const closed = doneTask(db, {
    taskId,
    executor,
    report: {
      summary,
      checks: listFlag(args, 'checks'),
      left: stringFlag(args, 'left'),
      commit: commit ?? undefined,
    },
  })

  ok(closed, `${closed.id}  ${closed.status === 'in_review' ? 'на ревью' : 'закрыта'}`)
  return 0
}


