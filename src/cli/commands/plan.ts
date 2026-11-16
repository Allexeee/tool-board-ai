import { readFileSync } from 'node:fs'
import { findProject } from '../../core/project.ts'
import { openDb } from '../../core/db.ts'
import { addPlan, approvePlan, getPlan } from '../../core/plans.ts'
import { applyPlan } from '../../core/apply.ts'
import { stringFlag, type ParsedArgs } from '../args.ts'
import { ok } from '../output.ts'
import { UserError } from '../errors.ts'

export default async function command(args: ParsedArgs) {
  const project = findProject(process.cwd())
  if (!project) throw new UserError(3, 'проект не найден: выполните toolbox-al init')
  const db = openDb(project.dbPath)

  const requestId = args.positionals[0] ?? stringFlag(args, 'request')
  if (!requestId) throw new UserError(3, 'использование: plan show|approve|apply|new R1')
  const version = stringFlag(args, 'version') ? Number(stringFlag(args, 'version')) : undefined

  if (args.sub === 'new') {
    const file = args.positionals[1] ?? stringFlag(args, 'from')
    if (!file) throw new UserError(3, 'использование: plan new R1 plan.json')

    // PowerShell и часть редакторов пишут UTF-8 BOM: для JSON это мусор в начале
    const raw = readFileSync(file, 'utf8').replace(/^\uFEFF/, '')
    let body: { title: string; assumptions?: string[]; stages: never[] }
    try {
      body = JSON.parse(raw) as { title: string; assumptions?: string[]; stages: never[] }
    } catch (error) {
      throw new UserError(3, `не разобрать JSON плана ${file}: ${(error as Error).message}`)
    }
    const plan = addPlan(db, {
      requestId,
      title: body.title,
      assumptions: body.assumptions ?? [],
      stages: body.stages,
    })
    ok(plan, `${plan.id}  v${plan.version}  ${plan.title}`)
    return 0
  }

  if (args.sub === 'approve') {
    const plan = approvePlan(db, { requestId, version: version ?? 0, actor: 'owner' })
    ok(plan, `план v${plan.version} утверждён`)
    return 0
  }

  if (args.sub === 'apply') {
    const result = applyPlan(db, { requestId, version, actor: 'orchestrator' })
    ok(result, `${result.feature.id}  ${result.feature.name}: этапов ${result.stages.length}, задач ${result.tasks.length}`)
    return 0
  }

  const plan = getPlan(db, { requestId, version })
  if (!plan) throw new UserError(3, `план для ${requestId} не найден`)

  const steps = plan.stages
    .flatMap((stage) => [
      `${stage.name} — ${stage.goal} (appetite ${stage.appetite})`,
      ...stage.steps.map((step) => `  [${step.skill}, ${step.size}] ${step.title}`),
    ])
    .join('\n')

  ok(
    plan,
    `${plan.id}  v${plan.version}  ${plan.title}${plan.approvedAt ? '  утверждён' : ''}\n` +
      (plan.assumptions.length ? `допущения: ${plan.assumptions.join('; ')}\n\n` : '\n') +
      steps,
  )
  return 0
}
