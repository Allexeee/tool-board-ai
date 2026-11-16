export type TaskKind = 'task' | 'defect' | 'incident'
export type TaskSize = 'XS' | 'S' | 'M' | 'L'
export type TaskClass = 'expedite' | 'fixed_date' | 'standard' | 'intangible' | 'quick'
export type TaskScope = string[] | 'exclusive'

export interface NewTask {
  stageId: string
  title: string
  kind?: TaskKind
  dod: string[]
  checkCmd?: string
  size: TaskSize
  sizeReason?: string
  skill: string
  class: TaskClass
  scope: TaskScope
}

const VAGUE_TITLE = new Set(['оплата', 'фикс', 'доработки', 'разное', 'задачи', 'правки'])

export function validateTaskInput(input: NewTask): { errors: string[]; warnings: string[] } {
  const errors: string[] = []
  const warnings: string[] = []

  if (!input.dod || input.dod.length === 0) {
    errors.push('нужен DoD: хотя бы один проверяемый пункт (--dod)')
  } else if (input.dod.length > 3) {
    errors.push('DoD: не больше трёх пунктов, иначе задача не помещается в один шаг')
  }

  if (!input.skill) errors.push('нужен навык (--skill)')

  const scopeEmpty = Array.isArray(input.scope) && input.scope.length === 0
  if (!input.scope || scopeEmpty) {
    errors.push('нужна область файлов (--scope) или явное --scope exclusive')
  }

  if (input.size === 'XL') {
    errors.push('размер XL — это фича, а не задача: нарежьте на этапы')
  }
  if (input.size === 'L' && !input.sizeReason) {
    errors.push('размер L требует причины (--size-reason)')
  }

  const title = (input.title ?? '').trim().toLowerCase()
  if (title.split(/\s+/).length < 2 || VAGUE_TITLE.has(title)) {
    warnings.push('заголовок похож на тему, а не на шаг: нужен глагол и артефакт')
  }

  return { errors, warnings }
}
