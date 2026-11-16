import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { getFeature, listFeatures, type Feature } from './features.ts'
import { listStages } from './stages.ts'
import { listTasks } from './tasks.ts'
import { UserError } from '../cli/errors.ts'

const NAME = /^[a-z0-9][a-z0-9-]*$/

function templatesDir(root: string): string {
  return join(root, '.toolbox-al', 'templates')
}

export function saveTemplate(
  root: string,
  input: { name: string; featureId: string; db: DatabaseSync },
): string {
  if (!NAME.test(input.name)) {
    throw new UserError(3, `имя шаблона — только строчные латинские буквы, цифры и дефис: ${input.name}`)
  }

  const feature = getFeature(input.db, input.featureId)
  if (!feature) throw new UserError(3, `фича ${input.featureId} не найдена`)

  const lines: string[] = [`# ${input.name}`, '', `Из фичи ${feature.id}: ${feature.name}`, '']

  for (const stage of listStages(input.db, feature.id)) {
    lines.push(`## ${stage.name}`, `Цель: ${stage.goal}`, `Appetite: ${stage.appetite}`, '')
    for (const task of listTasks(input.db, { stageId: stage.id })) {
      lines.push(`- [${task.skill}, ${task.size}] ${task.title}`)
      lines.push(`  DoD: ${task.dod.join('; ')}`)
      lines.push(`  scope: ${task.scope === 'exclusive' ? 'exclusive' : task.scope.join(', ')}`)
    }
    lines.push('')
  }

  mkdirSync(templatesDir(root), { recursive: true })
  const path = join(templatesDir(root), `${input.name}.md`)
  writeFileSync(path, lines.join('\n'), 'utf8')
  return path
}

export function listTemplates(root: string): string[] {
  const dir = templatesDir(root)
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((file) => file.endsWith('.md'))
    .map((file) => file.replace(/\.md$/, ''))
    .sort()
}

export function showTemplate(root: string, name: string): string {
  const path = join(templatesDir(root), `${name}.md`)
  if (!existsSync(path)) throw new UserError(3, `шаблон ${name} не найден`)
  return readFileSync(path, 'utf8')
}

export function similarFeatures(db: DatabaseSync, query: string): Feature[] {
  const words = query
    .toLowerCase()
    .split(/[^a-zа-я0-9]+/)
    .filter((word) => word.length > 2)

  return listFeatures(db)
    .map((feature) => {
      const name = feature.name.toLowerCase()
      const score = words.filter((word) => name.includes(word)).length
      return { feature, score }
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)
    .map((item) => item.feature)
}
