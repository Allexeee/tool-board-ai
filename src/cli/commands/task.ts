import { findProject } from '../../core/project.ts'
import { openDb } from '../../core/db.ts'
import { advanceTime } from '../../core/clock.ts'
import { listEvents } from '../../core/events.ts'
import { getStage } from '../../core/stages.ts'
import { getFeature } from '../../core/features.ts'
import { taskContext } from '../../core/context.ts'
import { decisionsFor } from '../../core/decisions.ts'
import { getExecutor } from '../../core/executors.ts'
import { agentRelativePath } from '../../core/agents.ts'
import { unblockTask } from '../../core/block.ts'
import { createTask, deferTask, editTask, getTask, listTasks, openTasks, setTaskSession, undeferTask, type EditableTask, type TaskClass, type TaskSize } from '../../core/tasks.ts'
import { boolFlag, listFlag, stringFlag, type ParsedArgs } from '../args.ts'
import { ok } from '../output.ts'
import { UserError } from '../errors.ts'

export default async function command(args: ParsedArgs) {
  const project = findProject(process.cwd())
  if (!project) throw new UserError(3, 'проект не найден: выполните toolbox-al init')
  const db = openDb(project.dbPath)

  if (args.sub === 'add') {
    const first = args.positionals[0] ?? stringFlag(args, 'stage')
    const isStage = first ? /^F\d+\.S\d+$/.test(first) : false

    const stageId = isStage ? first : null
    const title = (isStage ? args.positionals[1] : first) ?? stringFlag(args, 'title')
    if (!title) {
      throw new UserError(3, 'использование: task add F1.S1 "Заголовок" … или task add "Заголовок" … для пула')
    }

    const scopes = listFlag(args, 'scope')
    const scope = scopes.length === 1 && scopes[0] === 'exclusive' ? 'exclusive' as const : scopes

    const task = createTask(db, {
      stageId,
      title,
      dod: listFlag(args, 'dod'),
      size: (stringFlag(args, 'size') as TaskSize) ?? 'S',
      sizeReason: stringFlag(args, 'size-reason'),
      skill: stringFlag(args, 'skill') ?? '',
      class: (stringFlag(args, 'class') as TaskClass) ?? 'standard',
      scope,
      kind: (stringFlag(args, 'kind') as 'task' | 'defect' | 'incident') ?? 'task',
      severity: stringFlag(args, 'severity') as 'S1' | 'S2' | 'S3' | 'S4' | undefined,
      review: (stringFlag(args, 'review') as 'none' | 'agent' | 'owner') ?? 'none',
      checkCmd: stringFlag(args, 'check'),
    })

    ok(task, `${task.id}  ${task.size}  ${task.skill}  ${task.title}`)
    return 0
  }

  if (args.sub === 'edit') {
    const id = args.positionals[0]
    if (!id) {
      throw new UserError(3, 'использование: task edit F1.S1-1 --dod "…" --scope "src/**"')
    }

    const editable = ['title', 'dod', 'scope', 'size', 'size-reason', 'skill', 'class', 'kind', 'severity', 'check']
    const service = ['json', 'as', 'help', 'project']
    const given = Object.keys(args.flags).filter((name) => !service.includes(name))
    const unknown = given.filter((name) => !editable.includes(name))
    if (unknown.length > 0) {
      throw new UserError(
        3,
        `неизвестное поле: --${unknown[0]}. Допустимые: ${editable.map((name) => '--' + name).join(', ')}`,
      )
    }
    if (given.length === 0) {
      throw new UserError(3, 'нечего менять: укажите хотя бы одно поле')
    }

    const patch: EditableTask = {}
    if (given.includes('title')) patch.title = stringFlag(args, 'title')
    if (given.includes('dod')) patch.dod = listFlag(args, 'dod')
    if (given.includes('scope')) {
      const scopes = listFlag(args, 'scope')
      patch.scope = scopes.length === 1 && scopes[0] === 'exclusive' ? 'exclusive' : scopes
    }
    if (given.includes('size')) patch.size = stringFlag(args, 'size') as TaskSize
    if (given.includes('size-reason')) patch.sizeReason = stringFlag(args, 'size-reason')
    if (given.includes('skill')) patch.skill = stringFlag(args, 'skill')
    if (given.includes('class')) patch.class = stringFlag(args, 'class') as TaskClass
    if (given.includes('kind')) patch.kind = stringFlag(args, 'kind') as 'task' | 'defect' | 'incident'
    if (given.includes('severity')) patch.severity = stringFlag(args, 'severity') as 'S1' | 'S2' | 'S3' | 'S4'
    if (given.includes('check')) patch.checkCmd = stringFlag(args, 'check')

    const actor = stringFlag(args, 'as') ?? 'owner'
    const task = editTask(db, { id, actor, patch })
    ok(task, `${task.id}  ${task.size}  ${task.skill}  ${task.title}`)
    return 0
  }

  if (args.sub === 'open') {
    advanceTime(db)
    const brief = boolFlag(args, 'brief')
    const tasks = openTasks(db)
    ok(
      tasks,
      tasks.length === 0
        ? 'открытых задач нет'
        : tasks
            .map((task) => {
              if (brief) return `${task.id.padEnd(10)} ${task.status}`
              const holder = task.holder ? ` · ${task.holder}` : ''
              const reason = task.reason ? ` · ${task.reason}` : ''
              return `${task.id.padEnd(10)} ${task.status.padEnd(10)} ${task.title}${holder}${reason}`
            })
            .join('\n'),
    )
    return 0
  }

  if (args.sub === 'unblock') {
    const id = args.positionals[0]
    if (!id) throw new UserError(3, 'использование: task unblock F1.S1-1 --note "почему"')

    const task = unblockTask(db, {
      taskId: id,
      actor: stringFlag(args, 'as') ?? 'owner',
      note: stringFlag(args, 'note'),
    })
    ok(task, `${task.id}  снова ready`)
    return 0
  }

  if (args.sub === 'defer') {
    const id = args.positionals[0]
    if (!id) throw new UserError(3, 'использование: task defer F1.S1-1 --reason "почему ждёт"')

    const task = deferTask(db, {
      id,
      actor: stringFlag(args, 'as') ?? 'owner',
      reason: stringFlag(args, 'reason') ?? '',
    })
    ok(task, `${task.id}  отложена: ${task.reason}`)
    return 0
  }

  if (args.sub === 'undefer') {
    const id = args.positionals[0]
    if (!id) throw new UserError(3, 'использование: task undefer F1.S1-1')

    const task = undeferTask(db, { id, actor: stringFlag(args, 'as') ?? 'owner' })
    ok(task, `${task.id}  снова в работе: ${task.status}`)
    return 0
  }

  if (args.sub === 'brief') {
    const id = args.positionals[0]
    if (!id) throw new UserError(3, 'использование: task brief F1.S1-1 [--as worker-1]')

    const task = getTask(db, id)
    if (!task) throw new UserError(3, `задача ${id} не найдена`)

    const stage = task.stageId ? getStage(db, task.stageId) : null
    const feature = stage ? getFeature(db, stage.featureId) : null
    const root = feature?.worktree ?? project.root

    // Бриф — конверт задачи. Личность исполнителя живёт в .opencode/agents/<id>.md,
    // поэтому навыки и правила здесь не пересказываются.
    const agent = stringFlag(args, 'as') ?? task.holder
    const executor = agent ? getExecutor(db, agent) : null
    const agentFile = agent && executor?.kind === 'agent' ? agentRelativePath(agent) : null

    const lines = [
      `id: ${task.id}`,
      `агент: ${agent ?? 'не назначен'}`,
      ...(agentFile ? [`файл агента: ${agentFile}`] : []),
      ...(task.session ? [`сессия: ${task.session}`] : []),
      `каталог: ${root}`,
      `дальше: node bin/toolbox-al.ts task show ${task.id}`,
      `        node bin/toolbox-al.ts task context ${task.id}`,
    ]

    ok({ id: task.id, agent, root, agentFile, session: task.session }, lines.join('\n'))
    return 0
  }

  if (args.sub === 'context') {
    const id = args.positionals[0]
    if (!id) throw new UserError(3, 'использование: task context F1.S1-1')

    const task = getTask(db, id)
    if (!task) throw new UserError(3, `задача ${id} не найдена`)

    const stage = task.stageId ? getStage(db, task.stageId) : null
    const feature = stage ? getFeature(db, stage.featureId) : null
    const root = feature?.worktree ?? project.root

    const context = taskContext(db, task, root)
    const lines = [
      `${task.id}  ${task.title}`,
      `статус: ${task.status}${task.holder ? ' · держит ' + task.holder : ''}`,
      `DoD: ${task.dod.join('; ')}`,
      `область: ${task.scope === 'exclusive' ? 'эксклюзивно' : task.scope.join(', ')}`,
      '',
      '## Файлы области',
      context.files.length === 0
        ? 'нет'
        : context.files
            .map((file) => `${file.path}${file.lines >= 0 ? `  ${file.lines} стр.` : ''}`)
            .join('\n'),
    ]

    if (context.dependsOn.length > 0) {
      lines.push('', `зависит от: ${context.dependsOn.join(', ')}`)
    }

    if (context.decisions.length > 0) {
      lines.push('', '## Решения')
      for (const decision of context.decisions) {
        lines.push(`${decision.id}  ${decision.question} → ${decision.choice}`)
      }
    }

    if (context.commits.length > 0) {
      lines.push('', '## Последние коммиты')
      for (const commit of context.commits) lines.push(`${commit.sha}  ${commit.subject}`)
    }

    if (context.warnings.length > 0) {
      lines.push('', '! ' + context.warnings.join('\n! '))
    }

    ok(context, lines.join('\n'))
    return 0
  }

  if (args.sub === 'session') {
    const id = args.positionals[0]
    if (!id) {
      throw new UserError(3, 'использование: task session F1.S1-1 --session ses_… | --clear')
    }

    const clear = boolFlag(args, 'clear')
    const session = stringFlag(args, 'session')
    if (clear && session !== undefined) {
      throw new UserError(3, 'нельзя одновременно --session и --clear: выберите одно')
    }
    if (!clear && args.flags.session !== undefined && session === undefined) {
      throw new UserError(3, 'нужен идентификатор сессии: --session ses_…')
    }

    // без флагов команда только показывает — как executor session
    if (!clear && session === undefined) {
      const shown = getTask(db, id)
      if (!shown) throw new UserError(3, `задача ${id} не найдена`)
      ok(shown, shown.session ? `${shown.id}: ${shown.session}` : `${shown.id}: сессия не задана`)
      return 0
    }

    const task = setTaskSession(db, {
      id,
      session: clear ? null : (session as string),
      actor: stringFlag(args, 'as') ?? 'owner',
    })
    ok(task, clear ? `${task.id}: сессия сброшена` : `${task.id}: сессия ${task.session}`)
    return 0
  }

  if (args.sub === 'show') {
    // статус должен совпадать с list: время пересчитывается и здесь
    advanceTime(db)
    const task = getTask(db, args.positionals[0] ?? '')
    if (!task) throw new UserError(3, 'задача не найдена')

    // ссылка на спеку живёт в отдельной колонке: карточка показывает её рядом с областью
    const spec = (
      db.prepare('select spec from tasks where id = ?').get(task.id) as { spec: string | null } | undefined
    )?.spec

    const lines = [
      `${task.id}  ${task.title}`,
      `размер: ${task.size} · навык: ${task.skill} · класс: ${task.class}` +
        (task.severity ? ` · severity ${task.severity}` : ''),
      `статус: ${task.status}${task.holder ? ' · держит ' + task.holder : ''}`,
      `DoD: ${task.dod.join('; ')}`,
      `область: ${task.scope === 'exclusive' ? 'эксклюзивно' : task.scope.join(', ')}`,
    ]

    if (spec) lines.push(`спека: ${spec}`)

    if (task.attempts > 0) lines.push(`попыток: ${task.attempts}`)
    if (task.reason) lines.push(`причина: ${task.reason}`)

    const done = db
      .prepare("select after, actor from events where type = 'task.done' and subject = ? order by id desc limit 1")
      .get(task.id) as { after: string; actor: string } | undefined

    if (done?.after) {
      const report = JSON.parse(done.after) as {
        summary?: string
        checks?: string[]
        left?: string
        commit?: string
      }
      lines.push('', '## Отчёт')
      if (report.summary) lines.push(report.summary)
      for (const check of report.checks ?? []) lines.push(`проверено: ${check}`)
      if (report.left) lines.push(`осталось: ${report.left}`)
      if (report.commit) lines.push(`коммит: ${report.commit.slice(0, 8)}`)
      lines.push(`закрыл: ${done.actor}`)
    }

    const reviews = db
      .prepare('select reviewer, verdict, comments from reviews where task_id = ? order by id')
      .all(task.id) as Array<{ reviewer: string; verdict: string; comments: string | null }>

    if (reviews.length > 0) {
      lines.push('', '## Ревью')
      for (const review of reviews) {
        const comment = review.comments ? `: ${review.comments}` : ''
        lines.push(`${review.verdict} — ${review.reviewer}${comment}`)
      }
    }

    // своя сессия задачи главнее сессии держателя: доработка идёт туда же
    const session = task.session ?? (task.holder ? getExecutor(db, task.holder)?.session ?? null : null)
    if (session) lines.push(`сессия: ${session}`)

    const subjects = [task.id]
    if (task.stageId) {
      subjects.push(task.stageId)
      const stage = getStage(db, task.stageId)
      if (stage) subjects.push(stage.featureId)
    }

    const decisions = decisionsFor(db, subjects)
    if (decisions.length > 0) {
      lines.push('', '## Решения')
      for (const decision of decisions) {
        lines.push(`${decision.id}  ${decision.question} → ${decision.choice}`)
      }
    }

    if (args.flags.history === true) {
      const format = (value: unknown): string => {
        if (value === undefined || value === null) return '—'
        if (Array.isArray(value)) return value.length === 0 ? '—' : value.join('; ')
        return String(value)
      }

      const edits = listEvents(db, { subject: task.id }).filter((event) => event.type === 'task.edited')

      lines.push('', '## История')
      if (edits.length === 0) {
        lines.push('изменений нет')
      } else {
        for (const event of edits) {
          const before = event.before ? (JSON.parse(event.before) as Record<string, unknown>) : {}
          const after = event.after ? (JSON.parse(event.after) as Record<string, unknown>) : {}
          lines.push(`${event.at}  ${event.actor}`)
          for (const key of Object.keys(after)) {
            lines.push(`  ${key}: ${format(before[key])} → ${format(after[key])}`)
          }
        }
      }
    }

    ok(task, lines.join('\n'))
    return 0
  }

  const stageId = args.positionals[0] ?? stringFlag(args, 'stage')
  // статусы пересчитываются перед показом: задача неактивного этапа честно зовётся planned
  advanceTime(db)
  const tasks = listTasks(db, stageId ? { stageId } : {})
  ok(
    tasks,
    tasks.length === 0
      ? 'задач нет'
      : tasks.map((t) => `${t.id.padEnd(10)} ${t.status.padEnd(10)} ${t.title}`).join('\n'),
  )
  return 0
}






