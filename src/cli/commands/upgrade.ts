import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { findProject } from '../../core/project.ts'
import { openDb } from '../../core/db.ts'
import { applyUpgrade, planUpgrade, toolRoot, toolVersion } from '../../core/upgrade.ts'
import { planOpenCode } from '../../core/opencode.ts'
import { boolFlag, stringFlag, type ParsedArgs } from '../args.ts'
import { ok } from '../output.ts'
import { UserError } from '../errors.ts'

export default async function command(args: ParsedArgs) {
  const project = findProject(process.cwd())
  if (!project) throw new UserError(3, 'проект не найден: выполните toolbox-al init')
  const db = openDb(project.dbPath, { allowOutdated: true })

  const from = stringFlag(args, 'from')
  const yes = boolFlag(args, 'yes')

  if (boolFlag(args, 'pin')) {
    const version = toolVersion()
    if (existsSync(project.configPath)) {
      const raw = readFileSync(project.configPath, 'utf8').replace(/^\uFEFF/, '')
      const config = JSON.parse(raw) as Record<string, unknown>
      writeFileSync(
        project.configPath,
        JSON.stringify({ ...config, toolVersion: version }, null, 2) + '\n',
        'utf8',
      )
    }
    ok({ version }, `проект закреплён на ${version}`)
    return 0
  }

  if (boolFlag(args, 'check') || !yes) {
    const plan = planUpgrade(db, { toolRoot, configPath: project.configPath, from })
    const lines = [
      `инструмент: ${plan.current.current}`,
      `проект закреплён на: ${plan.pinned}`,
      `схема: ${plan.schemaFrom} → ${plan.schemaTo}`,
      `источник версий: ${plan.current.source}`,
    ]

    if (!plan.outdated) {
      ok({ applied: false, plan }, 'обновлять нечего')
      return 1
    }

    const labels = {
      same: 'без изменений',
      update: 'обновится',
      missing: 'будет создан',
      blocked: 'без маркеров — перенесите вручную',
    } as const
    const target = plan.current.latest ?? plan.current.current
    const managed = planOpenCode(project.root, target).map((item) => {
      const head = `${item.path}: ${labels[item.status]}`
      return item.diff ? `${head}\n${item.diff.split('\n').map((line) => '    ' + line).join('\n')}` : head
    })

    ok(
      { applied: false, plan, files: planOpenCode(project.root, target) },
      lines.join('\n') + '\n\nФАЙЛЫ\n' + managed.join('\n') + '\n\nчтобы применить, повторите с --yes',
    )
    return 0
  }

  const result = applyUpgrade(db, {
    dbPath: project.dbPath,
    configPath: project.configPath,
    projectRoot: project.root,
    toolRoot,
    from,
    yes,
  })

  if (!result.applied) {
    ok({ applied: false, plan: result.plan }, 'обновлять нечего')
    return 1
  }

  ok(
    { applied: true, backup: result.backup, plan: result.plan },
    `обновлено до ${result.plan.current.latest ?? result.plan.current.current}\nкопия базы: ${result.backup}`,
  )
  return 0
}


