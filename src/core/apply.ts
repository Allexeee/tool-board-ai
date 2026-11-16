import type { DatabaseSync } from 'node:sqlite'
import { tx } from './db.ts'
import { addFeature, type Feature } from './features.ts'
import { activateNextStage, addStage, type Stage } from './stages.ts'
import { createTask, type Task } from './tasks.ts'
import { addDep } from './deps.ts'
import { getPlan, type Plan } from './plans.ts'
import { appendEvent } from './events.ts'
import { UserError } from '../cli/errors.ts'

export function validatePlan(plan: Plan): string[] {
  const errors: string[] = []

  if (!plan.approvedAt) errors.push('план не утверждён владельцем')

  if (plan.stages.length === 0) errors.push('в плане нет ни одного этапа')

  for (const stage of plan.stages) {
    if (!stage.name?.trim()) errors.push(`этап без имени`)
    if (!stage.goal?.trim()) errors.push(`этап «${stage.name}» без цели`)
    if (!stage.appetite?.trim()) errors.push(`этап «${stage.name}» без appetite`)

    stage.steps.forEach((step, index) => {
      const place = `${stage.name}/${index + 1}`
      if (!step.title?.trim()) errors.push(`${place}: нет заголовка`)
      if (!step.skill?.trim()) errors.push(`${place}: нет навыка`)
      if (!step.dod?.length) errors.push(`${place}: нет DoD`)
      if (!step.scope?.length) errors.push(`${place}: нет области`)
      if (step.size === 'XL') errors.push(`${place}: размер XL — это фича, а не шаг`)
      if (step.size === 'L') errors.push(`${place}: размер L не допускается в плане, нарежьте на M`)
      if (!['XS', 'S', 'M'].includes(step.size)) errors.push(`${place}: неизвестный размер ${step.size}`)

      for (const dep of step.deps ?? []) {
        if (!Number.isInteger(dep) || dep < 0 || dep >= stage.steps.length) {
          errors.push(`${place}: зависимость ${dep} вне этапа (шагов ${stage.steps.length})`)
        } else if (dep === index) {
          errors.push(`${place}: зависимость на самого себя`)
        }
      }
    })
  }

  return errors
}

export function applyPlan(
  db: DatabaseSync,
  input: { requestId: string; version?: number; actor?: string },
): { feature: Feature; stages: Stage[]; tasks: Task[] } {
  return tx(db, () => {
    const plan = getPlan(db, { requestId: input.requestId, version: input.version })
    if (!plan) throw new UserError(3, `план для запроса ${input.requestId} не найден`)
    if (plan.appliedAt) throw new UserError(1, `план ${plan.id} уже применён`)

    const errors = validatePlan(plan)
    if (errors.length > 0) {
      throw new UserError(3, 'план не применён:\n  ' + errors.join('\n  '))
    }

    const feature = addFeature(db, { requestId: plan.requestId, name: plan.title })
    const stages: Stage[] = []
    const tasks: Task[] = []

    for (const stagePlan of plan.stages) {
      const stage = addStage(db, {
        featureId: feature.id,
        name: stagePlan.name,
        goal: stagePlan.goal,
        appetite: stagePlan.appetite,
        acceptance: stagePlan.acceptance,
      })
      stages.push(stage)

      const created = stagePlan.steps.map((step) =>
        createTask(db, {
          stageId: stage.id,
          title: step.title,
          dod: step.dod,
          size: step.size,
          skill: step.skill,
          class: 'standard',
          scope: step.scope,
          review: 'agent',
        }),
      )
      tasks.push(...created)

      for (const [index, step] of stagePlan.steps.entries()) {
        for (const dep of step.deps ?? []) {
          const target = created[dep]
          if (!target) {
            throw new UserError(3, `шаг ${index + 1} этапа «${stagePlan.name}»: зависимость ${dep} не найдена`)
          }
          addDep(db, created[index].id, target.id)
        }
      }
    }

    if (stages[0]) activateNextStage(db, feature.id)

    db.prepare("update plans set applied_at = ?, feature_id = ? where id = ?").run(
      new Date().toISOString(),
      feature.id,
      plan.id,
    )
    db.prepare("update requests set status = 'planned' where id = ?").run(plan.requestId)
    appendEvent(db, {
      type: 'plan.applied',
      actor: input.actor ?? 'orchestrator',
      subject: plan.id,
      after: { feature: feature.id, tasks: tasks.length },
    })

    return { feature, stages, tasks }
  })
}
