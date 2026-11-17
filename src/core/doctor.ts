import type { DatabaseSync } from 'node:sqlite'
import { listExecutors } from './executors.ts'
import { listTasks } from './tasks.ts'
import { listFeatures } from './features.ts'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { hookInstalled } from './git/hooks.ts'
import { branchExists, isRepo, runGit } from './git/git.ts'
import { openCodeFilesPresent } from './opencode.ts'
import { stalePoolTasks } from './pool.ts'
import { staleBranches } from './git/clean.ts'

export interface Check {
  name: string
  ok: boolean
  detail?: string
}

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString()
const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString()

export function doctorReport(
  db: DatabaseSync,
  options: {
    ownerStaleDays?: number
    root?: string
    devBranch?: string
    branches?: { main: string; dev: string }
    branchRetentionDays?: number
    schedulerEnabled?: boolean
  } = {},
): { checks: Check[] } {
  const checks: Check[] = []
  const ownerStaleDays = options.ownerStaleDays ?? 3

  // схема проверяется при открытии базы, здесь остаётся то, что может сломаться в работе
  const quick = db.prepare('pragma quick_check').get() as Record<string, string> | undefined
  const integrity = quick ? Object.values(quick)[0] : 'нет ответа'
  checks.push({
    name: 'целостность базы',
    ok: integrity === 'ok',
    detail: integrity === 'ok' ? 'ok' : `quick_check: ${integrity}`,
  })

  const executors = listExecutors(db)
  checks.push({
    name: 'исполнители',
    ok: executors.length > 0,
    detail: executors.length === 0 ? 'никого нет: добавьте исполнителя' : executors.map((e) => e.id).join(', '),
  })

  const skills = new Set(executors.flatMap((executor) => executor.skills))
  const unstaffed = new Set(
    listTasks(db, { status: 'ready' })
      .map((task) => task.skill)
      .filter((skill) => !skills.has(skill)),
  )
  checks.push({
    name: 'навыки',
    ok: unstaffed.size === 0,
    detail: unstaffed.size === 0 ? 'все навыки закрыты' : 'без исполнителя: ' + [...unstaffed].join(', '),
  })

  const waitingOwner = listTasks(db, { status: 'needs_owner' }).filter(
    (task) => task.createdAt < daysAgo(ownerStaleDays),
  )
  checks.push({
    name: 'ждёт владельца',
    ok: waitingOwner.length === 0,
    detail: waitingOwner.length === 0 ? 'нет зависших' : `${waitingOwner.length} задач старше ${ownerStaleDays} дней`,
  })

  const blocked = listTasks(db, { status: 'blocked' }).filter((task) => task.createdAt < daysAgo(3))
  checks.push({
    name: 'blocked',
    ok: blocked.length === 0,
    detail: blocked.length === 0 ? 'нет зависших' : `${blocked.length} задач старше 3 дней`,
  })

  const staleQuick = listTasks(db, { status: 'active' }).filter((task) => {
    if (task.size !== 'XS') return false
    const taken = db
      .prepare("select max(at) as at from events where subject = ? and type = 'task.taken'")
      .get(task.id) as { at: string | null }
    return (taken.at ?? task.createdAt) < minutesAgo(15)
  })
  checks.push({
    name: 'быстрая полоса',
    ok: staleQuick.length === 0,
    detail: staleQuick.length === 0 ? 'нет XS старше 15 минут' : `переоценить: ${staleQuick.map((t) => t.id).join(', ')}`,
  })

  const priority = fairness(db)
  checks.push(priority)

  const orphanHand = db
    .prepare('select task_id from hand where task_id not in (select id from tasks)')
    .all() as Array<{ task_id: string }>
  checks.push({
    name: 'журнал',
    ok: orphanHand.length === 0,
    detail: orphanHand.length === 0 ? 'ссылки целы' : `руки ссылаются на пропавшие задачи: ${orphanHand.map((r) => r.task_id).join(', ')}`,
  })

  if (options.root) {
    checks.push(...gitChecks(db, options.root, options.devBranch ?? 'dev'))
    checks.push({
      name: 'плагин OpenCode',
      ok: openCodeFilesPresent(options.root).plugin,
      detail: openCodeFilesPresent(options.root).plugin
        ? 'на месте'
        : 'нет .opencode/plugins/toolbox-al — выполните init',
    })
  }

  const noWorktree = listFeatures(db).filter(
    (feature) => feature.status === 'active' && !feature.worktree,
  )
  checks.push({
    name: 'каталоги фич назначены',
    ok: noWorktree.length === 0,
    detail:
      noWorktree.length === 0
        ? 'на месте'
        : 'без каталога: ' + noWorktree.map((feature) => feature.id).join(', ') + ' — выполните feature start',
  })

  const closedWithDir = listFeatures(db).filter(
    (feature) =>
      (feature.status === 'done' || feature.status === 'cancelled') &&
      feature.worktree &&
      existsSync(feature.worktree),
  )
  checks.push({
    name: 'каталоги закрытых фич',
    ok: closedWithDir.length === 0,
    detail:
      closedWithDir.length === 0
        ? 'прибраны'
        : 'лежат: ' +
          closedWithDir.map((feature) => feature.id).join(', ') +
          ' — выполните feature clean ' +
          closedWithDir[0].id,
  })

  if (options.root) {
    const stale = staleBranches(db, {
      root: options.root,
      config: { branches: options.branches ?? { main: 'main', dev: 'dev' }, branchRetentionDays: options.branchRetentionDays },
    })
    checks.push({
      name: 'ветки закрытых фич',
      ok: stale.length === 0,
      detail:
        stale.length === 0
          ? 'прибраны'
          : 'ждут решения: ' +
            stale.map((item) => `${item.branch} (${item.featureId}: ${item.why})`).join(', '),
    })
  }

  const stalePlans = db
    .prepare('select id from plans where stale_at is not null and applied_at is null')
    .all() as Array<{ id: string }>
  checks.push({
    name: 'планы',
    ok: stalePlans.length === 0,
    detail:
      stalePlans.length === 0
        ? 'актуальны'
        : 'устарели после правки запроса: ' + stalePlans.map((plan) => plan.id).join(', '),
  })

  const stale = stalePoolTasks(db, 7)
  checks.push({
    name: 'пул',
    ok: stale.length === 0,
    detail: stale.length === 0 ? 'зависших нет' : `зависло ${stale.length}: ${stale.map((task) => task.id).join(', ')}`,
  })

  const routines = (db.prepare('select count(*) as c from routines').get() as { c: number }).c
  if (routines > 0) {
    checks.push({
      name: 'тикер',
      ok: options.schedulerEnabled === true,
      detail:
        options.schedulerEnabled === true
          ? 'включён'
          : 'выключен: рутины по расписанию не запустятся (toolbox-al scheduler enable)',
    })
  }

  return { checks }
}

function gitChecks(db: DatabaseSync, root: string, devBranch: string): Check[] {
  const checks: Check[] = []

  if (!isRepo(root)) {
    return [{ name: 'git', ok: true, detail: 'не репозиторий: ветки и коммиты выключены' }]
  }

  const gitDir = runGit(root, ['rev-parse', '--absolute-git-dir'])

  checks.push({
    name: 'git-хук',
    ok: hookInstalled(gitDir),
    detail: hookInstalled(gitDir)
      ? `защищены коммит и merge в ${devBranch} и main`
      : 'хук не установлен: коммит и merge в main пройдут',
  })

  checks.push({
    name: 'ветка dev',
    ok: branchExists(root, devBranch),
    detail: branchExists(root, devBranch) ? devBranch : `ветки ${devBranch} нет: этапы некуда сливать`,
  })

  const missing = listFeatures(db)
    .filter((feature) => feature.worktree && !existsSync(feature.worktree))
    .map((feature) => feature.id)

  checks.push({
    name: 'каталоги фич на месте',
    ok: missing.length === 0,
    detail: missing.length === 0 ? 'на месте' : `нет каталога у: ${missing.join(', ')}`,
  })

  return checks
}

function fairness(db: DatabaseSync): Check {
  const features = listFeatures(db)
  if (features.length === 0) return { name: 'приоритеты', ok: true, detail: 'фич нет' }

  const first = features[0]
  const stages = db.prepare('select id from stages where feature_id = ?').all(first.id) as Array<{ id: string }>
  const stageIds = stages.map((stage) => stage.id)
  if (stageIds.length === 0) return { name: 'приоритеты', ok: true, detail: 'у первой фичи нет этапов' }

  const placeholders = stageIds.map(() => '?').join(', ')
  const tasks = db
    .prepare(`select id, status from tasks where stage_id in (${placeholders})`)
    .all(...stageIds) as Array<{ id: string; status: string }>

  const ready = tasks.filter((task) => task.status === 'ready').length
  const active = tasks.filter((task) => task.status === 'active').length
  const expediteActive = (
    db.prepare("select count(*) as c from tasks where class = 'expedite' and status = 'active'").get() as { c: number }
  ).c

  if (ready > 0 && active === 0 && expediteActive > 0) {
    return {
      name: 'приоритеты',
      ok: false,
      detail: `фича ${first.id} ранга 1 стоит без работы, пока идёт срочное`,
    }
  }

  return { name: 'приоритеты', ok: true, detail: 'очередь соответствует рангам' }
}


