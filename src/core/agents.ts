import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { UserError } from '../cli/errors.ts'
import type { Executor } from './executors.ts'

/** Куда пишутся файлы агентов OpenCode: по файлу на исполнителя-агента. */
export const AGENTS_DIR = '.opencode/agents'

/** Статус сверки файла агента с базой. `invalid` — id не годится для имени файла. */
export type AgentProblemStatus = 'missing' | 'drift' | 'invalid'

export interface AgentProblem {
  id: string
  /** Путь от корня проекта; у `invalid` пустой: файла быть не может. */
  path: string
  status: AgentProblemStatus
}

export type AgentSyncStatus = 'created' | 'updated' | 'unchanged'

export interface AgentSync {
  id: string
  path: string
  status: AgentSyncStatus
}

/**
 * Итог удаления файла: `removed` — файл убран, `absent` — файла и не было,
 * `failed` — файл остался из-за ошибки файловой системы.
 */
export type AgentRemovalStatus = 'removed' | 'absent' | 'failed'

export interface AgentRemoval {
  id: string
  /** Путь убранного файла от корня проекта; у `absent` пустой. */
  path: string
  status: AgentRemovalStatus
  /** Почему файл остался; заполнено только у `failed`. */
  warning?: string
}

/**
 * Итог переноса файла: `moved` — новый файл создан (старый убран, если удалось),
 * `absent` — переносить было нечего, `failed` — новый файл создать не удалось.
 */
export type AgentMoveStatus = 'moved' | 'absent' | 'failed'

export interface AgentMove {
  from: string
  to: string
  /** Путь нового файла от корня проекта; у `absent` пустой. */
  path: string
  /** Почему перенос неполон или не удался; у остатка старого файла тоже заполнено. */
  warning?: string
}

/** id становится именем файла, поэтому в нём только латиница, цифры, точка, дефис, подчёркивание. */
export function isAgentId(id: string): boolean {
  return /^[A-Za-z0-9_][A-Za-z0-9._-]*$/.test(id)
}

export function agentRelativePath(id: string): string {
  return `${AGENTS_DIR}/${id}.md`
}

/** Строка YAML в двойных кавычках: ресурсы прав и описание содержат звёздочки и двоеточия. */
function quote(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

/**
 * Файл агента OpenCode: frontmatter из базы (описание, модель, права, лимит шагов)
 * и короткое тело с характером работы. Без дат и прочего изменчивого — чтобы
 * повторный sync при неизменной базе давал тот же текст.
 */
export function renderAgent(executor: Executor): string {
  if (!isAgentId(executor.id)) {
    throw new UserError(
      3,
      `id исполнителя «${executor.id}» не годится для имени файла: нужны латиница, цифры, точка, дефис или подчёркивание`,
    )
  }

  const skills = executor.skills.length > 0 ? executor.skills.join(', ') : 'без навыков'
  const lines = [
    '---',
    `description: ${quote(`исполнитель ${executor.id} · навыки: ${skills}`)}`,
    'mode: subagent',
  ]

  if (executor.model) lines.push(`model: ${executor.model}`)
  lines.push(`steps: ${executor.steps}`)

  if (executor.permissions.length === 0) {
    lines.push('permissions: []')
  } else {
    lines.push('permissions:')
    for (const rule of executor.permissions) {
      lines.push(`  - action: ${rule.action}`)
      lines.push(`    resource: ${quote(rule.resource)}`)
      lines.push(`    effect: ${rule.effect}`)
    }
  }

  lines.push('---')
  lines.push('')
  lines.push(`Ты — исполнитель ${executor.id} в очереди toolbox-al. Навыки: ${skills}.`)
  lines.push('')
  lines.push(
    `- Задачу берёшь через \`take --as ${executor.id}\`, закрываешь через \`done --as ${executor.id}\` с отчётом и проверками.`,
  )
  lines.push('- Работаешь только в своём каталоге и только в области задачи; чужие файлы не трогаешь.')
  lines.push('- В git не пишешь: коммит делает приложение после done.')
  lines.push('- Застрял или нужен выбор владельца — block или ask, а не догадки.')
  lines.push('- Права и лимит шагов заданы в этом файле: сам их не расширяешь.')
  lines.push('')

  return lines.join('\n')
}

/** Пишет файл, только если текст отличается: повторный sync не трогает файл и его mtime. */
export function syncAgent(root: string, executor: Executor): AgentSync {
  const relative = agentRelativePath(executor.id)
  const path = join(root, AGENTS_DIR, `${executor.id}.md`)
  const content = renderAgent(executor)

  if (existsSync(path)) {
    if (readFileSync(path, 'utf8') === content) {
      return { id: executor.id, path: relative, status: 'unchanged' }
    }
    writeFileSync(path, content, 'utf8')
    return { id: executor.id, path: relative, status: 'updated' }
  }

  mkdirSync(join(root, AGENTS_DIR), { recursive: true })
  writeFileSync(path, content, 'utf8')
  return { id: executor.id, path: relative, status: 'created' }
}

/** Синхронизирует всех исполнителей-агентов; люди файла агента не получают. */
export function syncAgents(root: string, executors: Executor[]): AgentSync[] {
  return executors
    .filter((executor) => executor.kind === 'agent')
    .map((executor) => syncAgent(root, executor))
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Убирает файл агента. Ошибка файловой системы не бросается: база к этому моменту
 * уже изменена, и откатывать её из-за файла нельзя — вызывающий сообщает предупреждение.
 */
export function removeAgent(root: string, id: string): AgentRemoval {
  if (!isAgentId(id)) return { id, path: '', status: 'absent' }

  const relative = agentRelativePath(id)
  const path = join(root, AGENTS_DIR, `${id}.md`)
  if (!existsSync(path)) return { id, path: '', status: 'absent' }

  try {
    rmSync(path)
  } catch (error) {
    return {
      id,
      path: relative,
      status: 'failed',
      warning: `файл ${relative} остался, удалите его вручную: ${errorText(error)}`,
    }
  }

  return { id, path: relative, status: 'removed' }
}

/**
 * Переносит файл агента на новое имя. Текст берётся из базы, поэтому в нём уже новое
 * имя; новый файл пишется раньше, чем убирается старый, — сбой удаления оставляет
 * старый файл с предупреждением, но перенос считается состоявшимся.
 */
export function moveAgent(root: string, from: string, executor: Executor): AgentMove {
  // Имена совпадают или файла агента быть не должно — переносить нечего.
  if (
    from === executor.id ||
    executor.kind !== 'agent' ||
    !isAgentId(from) ||
    !isAgentId(executor.id)
  ) {
    return { from, to: executor.id, path: '', status: 'absent' }
  }

  const source = join(root, AGENTS_DIR, `${from}.md`)
  if (!existsSync(source)) return { from, to: executor.id, path: '', status: 'absent' }

  const target = agentRelativePath(executor.id)
  try {
    syncAgent(root, executor)
  } catch (error) {
    return {
      from,
      to: executor.id,
      path: target,
      status: 'failed',
      warning: `новый файл ${target} не создан, поможет executor sync: ${errorText(error)}`,
    }
  }

  const removal = removeAgent(root, from)
  if (removal.status === 'failed') {
    return { from, to: executor.id, path: target, status: 'moved', warning: removal.warning }
  }

  return { from, to: executor.id, path: target, status: 'moved' }
}

/**
 * Расхождения файлов агентов с базой. Отсутствие каталога — это `missing`
 * у каждого, а не падение: doctor должен уметь сказать «выполните executor sync».
 */
export function agentProblems(root: string, executors: Executor[]): AgentProblem[] {
  const problems: AgentProblem[] = []

  for (const executor of executors) {
    if (executor.kind !== 'agent') continue

    if (!isAgentId(executor.id)) {
      problems.push({ id: executor.id, path: '', status: 'invalid' })
      continue
    }

    const relative = agentRelativePath(executor.id)
    const path = join(root, AGENTS_DIR, `${executor.id}.md`)

    if (!existsSync(path)) {
      problems.push({ id: executor.id, path: relative, status: 'missing' })
      continue
    }

    if (readFileSync(path, 'utf8') !== renderAgent(executor)) {
      problems.push({ id: executor.id, path: relative, status: 'drift' })
    }
  }

  return problems
}

export function formatAgentProblem(problem: AgentProblem): string {
  if (problem.status === 'missing') return `${problem.id} (нет файла)`
  if (problem.status === 'drift') return `${problem.id} (правлен руками)`
  return `${problem.id} (недопустимый id)`
}

/** Строка для вывода `executor remove`: что стало с файлом агента. */
export function formatAgentRemoval(removal: AgentRemoval): string {
  if (removal.status === 'removed') return `файл агента удалён: ${removal.path}`
  if (removal.status === 'failed') return `файл агента не удалён: ${removal.path}`
  return 'файла агента не было'
}

/** Строка для вывода `executor rename`: что стало с файлом агента. */
export function formatAgentMove(move: AgentMove): string {
  if (move.status === 'failed') return `файл агента не создан: ${move.path}`
  if (move.status === 'absent') return 'файла агента не было'
  return `файл агента: ${agentRelativePath(move.from)} → ${move.path}`
}
