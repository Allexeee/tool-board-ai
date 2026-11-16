import { spawnSync } from 'node:child_process'
import type { DatabaseSync } from 'node:sqlite'
import { branchExists, currentBranch, isRepo, resolveBranches, runGit } from './git.ts'
import { getFeature } from '../features.ts'
import { activateNextStage, getStage, listStages } from '../stages.ts'
import { createTask, listTasks } from '../tasks.ts'
import { appendEvent } from '../events.ts'
import { UserError } from '../../cli/errors.ts'

export interface MergeResult {
  merged: boolean
  commit?: string
  reason?: string
}

function runCheck(cwd: string, command: string): { ok: boolean; output: string } {
  const result =
    process.platform === 'win32'
      ? spawnSync('cmd.exe', ['/c', command], { cwd, encoding: 'utf8' })
      : spawnSync('sh', ['-c', command], { cwd, encoding: 'utf8' })

  return {
    ok: result.status === 0,
    output: `${result.stdout ?? ''}${result.stderr ?? ''}`.trim(),
  }
}

export function mergeStage(
  db: DatabaseSync,
  input: { root: string; stageId: string; config: { branches: { main: string; dev: string }; check: string | null } },
): MergeResult {
  const stage = getStage(db, input.stageId)
  if (!stage) throw new UserError(3, `этап ${input.stageId} не найден`)

  if (!isRepo(input.root)) throw new UserError(3, `не git-репозиторий: ${input.root}`)

  const feature = getFeature(db, stage.featureId)
  if (!feature) throw new UserError(3, `фича ${stage.featureId} не найдена`)
  if (!feature.branch) throw new UserError(3, `у фичи ${feature.id} нет ветки: выполните feature start`)

  const tasks = listTasks(db, { stageId: stage.id })
  const open = tasks.filter((task) => task.status !== 'done')
  if (open.length > 0) {
    return { merged: false, reason: `не все задачи закрыты: ${open.map((task) => task.id).join(', ')}` }
  }

  if ((stage.acceptance === 'owner' || stage.acceptance === 'owner_before_next') && stage.status !== 'accepted') {
    return { merged: false, reason: 'этап не принят владельцем: stage accept' }
  }

  const { dev } = resolveBranches(input.root, input.config)
  if (!branchExists(input.root, dev)) {
    throw new UserError(3, `ветки ${dev} нет: создайте её от ${input.config.branches.main}`)
  }

  const check = feature.checkCmd ?? input.config.check
  if (check) {
    const result = runCheck(feature.worktree ?? input.root, check)
    if (!result.ok) return { merged: false, reason: `проверка "${check}" упала: ${result.output}` }
  }

  const original = currentBranch(input.root)
  try {
    runGit(input.root, ['checkout', dev])
    runGit(input.root, ['merge', '--no-ff', feature.branch, '-m', `${stage.id}: ${stage.name}`], {
      AL_ALLOW: '1',
    })
  } catch (error) {
    let unmerged: string[] = []
    try {
      unmerged = runGit(input.root, ['diff', '--name-only', '--diff-filter=U'])
        .split('\n')
        .filter(Boolean)
    } catch {
      unmerged = []
    }

    try {
      runGit(input.root, ['merge', '--abort'])
    } catch {
      appendEvent(db, { type: 'merge.abort_failed', actor: 'system', subject: stage.id })
    }
    if (original) runGit(input.root, ['checkout', original])

    if (unmerged.length > 0) {
      const skill = tasks[0]?.skill ?? 'general'
      const task = createTask(db, {
        stageId: stage.id,
        title: `Разрулить конфликт слияния ${stage.id}`,
        dod: ['конфликтующие файлы разрешены', 'слияние в dev проходит'],
        size: 'S',
        skill,
        class: 'expedite',
        scope: unmerged,
      })
      appendEvent(db, {
        type: 'merge.conflict',
        actor: 'system',
        subject: stage.id,
        note: unmerged.join(', '),
      })
      return { merged: false, reason: 'конфликт слияния', taskId: task.id }
    }

    throw error
  }

  const commit = runGit(input.root, ['rev-parse', 'HEAD'])

  db.prepare("update stages set status = 'merged', merged_at = ? where id = ?").run(new Date().toISOString(), stage.id)
  appendEvent(db, { type: 'stage.merged', actor: 'system', subject: stage.id, after: { commit } })

  const remaining = listStages(db, feature.id).filter((item) => item.status === 'planned')
  if (remaining.length === 0) {
    db.prepare("update features set status = 'done' where id = ?").run(feature.id)

    if (feature.requestId) {
      const open = db
        .prepare(
          "select count(*) as c from features where request_id = ? and status not in ('done', 'cancelled')",
        )
        .get(feature.requestId) as { c: number }

      if (open.c === 0) {
        db.prepare("update requests set status = 'closed' where id = ?").run(feature.requestId)
        appendEvent(db, {
          type: 'request.closed',
          actor: 'system',
          subject: feature.requestId,
          note: 'все фичи запроса закрыты',
        })
      }
    }
  } else {
    activateNextStage(db, feature.id)
  }

  if (original && original !== dev) {
    try {
      runGit(input.root, ['checkout', original])
    } catch {
      appendEvent(db, {
        type: 'branch.restore_failed',
        actor: 'system',
        subject: stage.id,
        note: `остались на ${dev}`,
      })
    }
  }

  return { merged: true, commit }
}
