import { openDb } from '../../core/db.ts'
import { doctorData, type DoctorResult } from '../../core/doctor.ts'
import { findProject } from '../../core/project.ts'
import type { ParsedArgs } from '../args.ts'
import { UserError } from '../errors.ts'
import { ok } from '../output.ts'

export default async function command(_args: ParsedArgs) {
  const project = findProject(process.cwd())
  if (!project) throw new UserError(3, 'проект не найден: выполните board init')
  const db = openDb(project.dbPath)

  try {
    const result = doctorData(db, project.root)
    ok(result, renderDoctor(result))
    if (result.errors.length > 0) return 3
    if (result.warnings.length > 0) return 1
    return 0
  } finally {
    db.close()
  }
}

function renderDoctor(result: DoctorResult): string {
  if (result.errors.length === 0 && result.warnings.length === 0) {
    return 'всё в порядке'
  }
  const lines: string[] = []
  for (const error of result.errors) lines.push(`!   ${error}`)
  for (const warning of result.warnings) lines.push(`~   ${warning}`)
  lines.push('')
  lines.push(
    result.errors.length > 0
      ? `ошибок: ${result.errors.length}`
      : `предупреждений: ${result.warnings.length}`,
  )
  return lines.join('\n')
}
