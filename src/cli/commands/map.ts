import { existsSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { MAP_FILE, buildMap, renderMap, writeMap } from '../../core/map.ts'
import { boolFlag, type ParsedArgs } from '../args.ts'
import { ok } from '../output.ts'
import { UserError } from '../errors.ts'

export default async function command(args: ParsedArgs): Promise<number> {
  const root = process.cwd()
  const dirs = args.positionals.map((dir) => insideRoot(root, dir))
  const map = buildMap(root, { dirs })

  if (map.files.length === 0) {
    process.stderr.write('модулей не найдено: укажите каталог, например map src\n')
    return 1
  }

  if (boolFlag(args, 'write')) {
    writeMap(map, join(root, MAP_FILE))
    ok(
      { path: MAP_FILE, files: map.files.length, edges: map.edges },
      `карта записана: ${MAP_FILE} (модулей: ${map.files.length}, связей: ${map.edges})`,
    )
    return 0
  }

  ok(map, renderMap(map))
  return 0
}

/** Позиционные аргументы — каталоги внутри текущего корня. */
function insideRoot(root: string, dir: string): string {
  const abs = resolve(root, dir)
  const rel = relative(root, abs)
  if (rel.startsWith('..') || isAbsolute(rel)) throw new UserError(3, `путь вне проекта: ${dir}`)
  if (!existsSync(abs)) throw new UserError(3, `нет такого пути: ${dir}`)
  return rel === '' ? '.' : rel
}
