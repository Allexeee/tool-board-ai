import { readFileSync } from 'node:fs'
import { findProject } from '../../core/project.ts'
import { openDb } from '../../core/db.ts'
import { addPlan, approvePlan, getPlan, getPlanById } from '../../core/plans.ts'
import { applyPlan, validatePlan } from '../../core/apply.ts'
import { stringFlag, type ParsedArgs } from '../args.ts'
import { ok } from '../output.ts'
import { UserError } from '../errors.ts'

export default async function command(args: ParsedArgs) {
  const project = findProject(process.cwd())
  if (!project) throw new UserError(3, 'проект не найден: выполните toolbox-al init')
  const db = openDb(project.dbPath)

  let requestId = args.positionals[0] ?? stringFlag(args, 'request')
  if (!requestId) throw new UserError(3, 'использование: plan show|approve|apply|new R1')
  let version = stringFlag(args, 'version') ? Number(stringFlag(args, 'version')) : undefined

  // план можно адресовать по P-id из вывода, а не только по запросу
  if (/^P\d+$/.test(requestId)) {
    const byId = getPlanById(db, requestId)
    if (!byId) throw new UserError(3, `план ${requestId} не найден`)
    requestId = byId.requestId
    version = byId.version
  }

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
    const pending = getPlan(db, { requestId, version })
    if (!pending) throw new UserError(3, `план для ${requestId} не найден`)

    const errors = validatePlan({ ...pending, approvedAt: new Date().toISOString() })
    if (errors.length > 0) {
      throw new UserError(3, 'план не утверждён:\n  ' + errors.join('\n  '))
    }

    const plan = approvePlan(db, { requestId, version: version ?? pending.version, actor: 'owner' })
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
      `${stage.name} — ${stage.goal} (appetite ${stage.appetite}, приёмка ${stage.acceptance})`,
      ...stage.steps.map((step) => {
        const lines = [
          `  [${step.skill}, ${step.size}] ${step.title}`,
          `    DoD: ${step.dod.join('; ')}`,
          `    область: ${step.scope.join(', ')}`,
        ]
        if (step.deps?.length) lines.push(`    зависит от: ${step.deps.map((index) => index + 1).join(', ')}`)
        return lines.join('\n')
      }),
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

