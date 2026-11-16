import { findProject } from '../../core/project.ts'
import { openDb } from '../../core/db.ts'
import { getGate, listGates, resetGate, satisfyGate } from '../../core/gates.ts'
import { type ParsedArgs } from '../args.ts'
import { ok } from '../output.ts'
import { UserError } from '../errors.ts'

export default async function command(args: ParsedArgs) {
  const project = findProject(process.cwd())
  if (!project) throw new UserError(3, 'проект не найден: выполните toolbox-al init')
  const db = openDb(project.dbPath)

  const id = args.positionals[0]

  if (args.sub === 'approve') {
    if (!id) throw new UserError(3, 'использование: gate approve G1')
    const gate = satisfyGate(db, { gateId: id, actor: 'owner' })
    ok(gate, `гейт ${gate.id} ${gate.name} одобрен`)
    return 0
  }

  if (args.sub === 'reset') {
    if (!id) throw new UserError(3, 'использование: gate reset G1')
    const gate = resetGate(db, { gateId: id, actor: 'owner' })
    ok(gate, `гейт ${gate.id} ${gate.name} сброшен`)
    return 0
  }

  if (args.sub === 'show') {
    if (!id) throw new UserError(3, 'использование: gate show G1')
    const gate = getGate(db, id)
    if (!gate) throw new UserError(3, 'гейт не найден')
    ok(gate, `${gate.id}  ${gate.kind}  ${gate.name}  ${gate.satisfiedAt ? 'закрыт' : 'открыт'}`)
    return 0
  }

  const gates = listGates(db)
  ok(
    gates,
    gates.length === 0
      ? 'гейтов нет'
      : gates.map((gate) => `${gate.id.padEnd(4)} ${gate.kind.padEnd(11)} ${gate.name}  ${gate.satisfiedAt ? 'закрыт' : 'открыт'}`).join('\n'),
  )
  return 0
}
