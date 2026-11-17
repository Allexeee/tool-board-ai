import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
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
