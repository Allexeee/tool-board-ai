import { findProject } from '../../core/project.ts'
import { openDb } from '../../core/db.ts'
import { syncAgent, syncAgents, type AgentSyncStatus } from '../../core/agents.ts'
import {
  addExecutor,
  bindSession,
  formatPermission,
  getExecutor,
  listExecutors,
  parsePermissions,
  removeExecutor,
  renameExecutor,
  resetSession,
  setModel,
  setPermissions,
  setSkills,
  setSteps,
} from '../../core/executors.ts'
import { boolFlag, listFlag, stringFlag, type ParsedArgs } from '../args.ts'
import { ok } from '../output.ts'
import { UserError } from '../errors.ts'

export default async function command(args: ParsedArgs) {
  const project = findProject(process.cwd())
  if (!project) throw new UserError(3, 'проект не найден: выполните toolbox-al init')
  const db = openDb(project.dbPath)

  if (args.sub === 'add') {
    const id = args.positionals[0]
    if (!id) throw new UserError(3, 'не указан id исполнителя')

    const skills = listFlag(args, 'skills')
      .flatMap((value) => value.split(','))
      .map((value) => value.trim())
      .filter(Boolean)

    const steps = stringFlag(args, 'steps')
    const executor = addExecutor(db, {
      id,
      kind: (stringFlag(args, 'kind') as 'human' | 'agent') ?? 'agent',
      skills,
      model: stringFlag(args, 'model') ?? null,
      permissions: parsePermissions({ allow: listFlag(args, 'allow'), deny: listFlag(args, 'deny') }),
      steps: steps === undefined ? undefined : Number(steps),
    })
    ok(executor, `${executor.id} добавлен: ${executor.skills.join(', ') || 'без навыков'}`)
    return 0
  }

  if (args.sub === 'rename') {
    const from = args.positionals[0]
    const to = args.positionals[1]
    if (!from || !to) throw new UserError(3, 'использование: executor rename old new')

    const executor = renameExecutor(db, { from, to, actor: 'orchestrator' })
    ok(executor, `${from} → ${executor.id}`)
    return 0
  }

  if (args.sub === 'remove') {
    const id = args.positionals[0]
    if (!id) throw new UserError(3, 'использование: executor remove w1')

    removeExecutor(db, { executorId: id, actor: 'owner' })
    ok({ id }, `${id} удалён`)
    return 0
  }

  if (args.sub === 'skills') {
    const id = args.positionals[0]
    if (!id) throw new UserError(3, 'использование: executor skills w1 --skills backend,frontend')

    const executor = setSkills(db, {
      executorId: id,
      skills: listFlag(args, 'skills').flatMap((value) => value.split(',')),
      actor: 'owner',
    })
    ok(executor, `${executor.id}: ${executor.skills.join(', ')}`)
    return 0
  }

  if (args.sub === 'model') {
    const id = args.positionals[0]
    if (!id) throw new UserError(3, 'использование: executor model w1 --model provider/model (или --model inherit)')

    const raw = stringFlag(args, 'model')
    if (raw === undefined) {
      throw new UserError(3, 'использование: executor model w1 --model provider/model, --model inherit — наследовать модель родителя')
    }

    const executor = setModel(db, { executorId: id, model: raw, actor: 'owner' })
    ok(
      executor,
      executor.model ? `${executor.id}: модель ${executor.model}` : `${executor.id}: модель наследуется от родителя`,
    )
    return 0
  }

  if (args.sub === 'permissions') {
    const id = args.positionals[0]
    if (!id) throw new UserError(3, 'использование: executor permissions w1 --allow "shell:git *" --deny "edit:*"')

    if (boolFlag(args, 'clear')) {
      const executor = setPermissions(db, { executorId: id, permissions: [], actor: 'owner' })
      ok(executor, `${executor.id}: особых прав нет`)
      return 0
    }

    const permissions = parsePermissions({ allow: listFlag(args, 'allow'), deny: listFlag(args, 'deny') })
    if (permissions.length === 0) {
      throw new UserError(
        3,
        'нужно хотя бы одно правило: --allow action:resource, --deny action:resource или --clear',
      )
    }

    const executor = setPermissions(db, { executorId: id, permissions, actor: 'owner' })
    ok(executor, `${executor.id}: ${permissions.map(formatPermission).join(', ')}`)
    return 0
  }

  if (args.sub === 'steps') {
    const id = args.positionals[0]
    if (!id) throw new UserError(3, 'использование: executor steps w1 --steps 12')

    const raw = stringFlag(args, 'steps')
    if (raw === undefined) throw new UserError(3, 'использование: executor steps w1 --steps 12')

    const executor = setSteps(db, { executorId: id, steps: raw, actor: 'owner' })
    ok(executor, `${executor.id}: лимит шагов ${executor.steps}`)
    return 0
  }

  if (args.sub === 'sync') {
    const id = args.positionals[0]

    if (id) {
      const executor = getExecutor(db, id)
      if (!executor) throw new UserError(3, `исполнитель ${id} не найден`)
      if (executor.kind === 'human') {
        ok({ id: executor.id, path: null, status: 'skipped' }, `${executor.id}: человек — файл агента не нужен`)
        return 0
      }

      const result = syncAgent(project.root, executor)
      ok(result, `${result.id}: ${syncStatusText(result.status)} ${result.path}`)
      return 0
    }

    const agents = listExecutors(db).filter((executor) => executor.kind === 'agent')
    if (agents.length === 0) {
      ok([], 'исполнителей-агентов нет: добавьте executor add w1 --skills backend')
      return 0
    }

    const results = syncAgents(project.root, agents)
    const created = results.filter((result) => result.status === 'created').length
    const updated = results.filter((result) => result.status === 'updated').length
    const unchanged = results.filter((result) => result.status === 'unchanged').length

    ok(
      results,
      results.map((result) => `${result.id.padEnd(12)} ${syncStatusText(result.status).padEnd(13)} ${result.path}`).join('\n') +
        `\n\nсоздано: ${created}, обновлено: ${updated}, без изменений: ${unchanged}`,
    )
    return 0
  }

  if (args.sub === 'bind') {
    const id = args.positionals[0]
    const session = stringFlag(args, 'session')
    if (!id || !session) throw new UserError(3, 'использование: executor bind w1 --session <ses_id>')

    const executor = bindSession(db, { executorId: id, session, actor: 'orchestrator' })
    ok(executor, `${executor.id}: сессия ${executor.session}`)
    return 0
  }

  if (args.sub === 'session') {
    const id = args.positionals[0]
    if (!id) throw new UserError(3, 'использование: executor session w1')

    const executor = getExecutor(db, id)
    if (!executor) throw new UserError(3, `исполнитель ${id} не найден`)

    ok(executor, executor.session ? `${executor.id}: ${executor.session}` : `${executor.id}: сессия не привязана`)
    return 0
  }

  if (args.sub === 'reset') {
    const id = args.positionals[0]
    if (!id) throw new UserError(3, 'использование: executor reset w1')

    const executor = resetSession(db, { executorId: id, actor: 'orchestrator' })
    ok(executor, `${executor.id}: сессия отвязана`)
    return 0
  }

  const rows = listExecutors(db)
  ok(
    rows,
    rows.length === 0
      ? 'исполнителей нет'
      : rows
          .map((e) => {
            const model = e.model ?? 'наследует'
            const permissions = e.permissions.map(formatPermission).join(', ') || 'без особых прав'
            return (
              `${e.id.padEnd(12)} ${e.kind.padEnd(6)} ${e.skills.join(', ')}` +
              `\n${' '.repeat(19)}модель: ${model} · шагов: ${e.steps} · права: ${permissions}`
            )
          })
          .join('\n'),
  )
  return 0
}

function syncStatusText(status: AgentSyncStatus): string {
  if (status === 'created') return 'создан'
  if (status === 'updated') return 'обновлён'
  return 'без изменений'
}


