import { findProject } from '../../core/project.ts'
import { openDb } from '../../core/db.ts'
import { addRoutine, addStep, listRoutines, listSteps } from '../../core/routines.ts'
import { addGate, listGates } from '../../core/gates.ts'
import { listFlag, stringFlag, type ParsedArgs } from '../args.ts'
import { ok } from '../output.ts'
import { UserError } from '../errors.ts'

export default async function command(args: ParsedArgs) {
  const project = findProject(process.cwd())
  if (!project) throw new UserError(3, 'проект не найден: выполните toolbox-al init')
  const db = openDb(project.dbPath)

  if (args.sub === 'add') {
    const name = args.positionals[0]
    const schedule = stringFlag(args, 'schedule')
    if (!name || !schedule) {
      throw new UserError(3, 'использование: routine add "Деплой" --schedule "daily 02:00" [--window 02:00-04:00]')
    }
    const routine = addRoutine(db, {
      name,
      schedule,
      window: stringFlag(args, 'window'),
      guard: stringFlag(args, 'guard'),
    })
    ok(routine, `${routine.id}  ${routine.name}  ${routine.schedule}`)
    return 0
  }

  if (args.sub === 'step') {
    const routineId = args.positionals[0]
    const title = args.positionals[1]
    const kind = (stringFlag(args, 'action') ?? 'agent') as 'agent' | 'mechanical'
    if (!routineId || !title) {
      throw new UserError(3, 'использование: routine step RU1 "Собрать" --action mechanical --cmd "npm run build"')
    }
    const step = addStep(db, {
      routineId,
      title,
      kind,
      skill: stringFlag(args, 'skill'),
      command: stringFlag(args, 'cmd'),
      dod: listFlag(args, 'dod'),
      scope: listFlag(args, 'scope'),
      onMissing: (stringFlag(args, 'on-missing') as 'block' | 'skip' | 'fallback') ?? 'block',
    })
    ok(step, `${step.id}  ${step.title}`)
    return 0
  }

  if (args.sub === 'gate') {
    const routineId = args.positionals[0]
    const kind = stringFlag(args, 'kind') as 'capability' | 'check' | 'approval' | undefined
    const name = args.positionals[1] ?? stringFlag(args, 'name')
    if (!routineId || !kind || !name) {
      throw new UserError(3, 'использование: routine gate RU1 --kind approval --name first_publish --once')
    }
    const gate = addGate(db, {
      routineId,
      kind,
      name,
      once: args.flags.once === true,
      payload: stringFlag(args, 'cmd'),
    })
    ok(gate, `${gate.id}  ${gate.kind}  ${gate.name}`)
    return 0
  }

  const routines = listRoutines(db)
  const text = routines
    .map((routine) => {
      const steps = listSteps(db, routine.id).map((step) => `    ${step.seq}. ${step.title} (${step.kind})`)
      const gates = listGates(db, routine.id).map((gate) => `    [${gate.kind}] ${gate.name}`)
      return `${routine.id}  ${routine.name}  ${routine.schedule}${steps.length ? '\n' + steps.join('\n') : ''}${
        gates.length ? '\n' + gates.join('\n') : ''
      }`
    })
    .join('\n')

  ok(routines, text || 'рутин нет')
  return 0
}
