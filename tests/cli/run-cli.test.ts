import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import { openDb } from '../../src/core/db.ts'
import { getRunRecord, reviewOf, reviewState } from '../../src/core/runs.ts'
import { makeRepo } from '../helpers/repo.ts'

const bin = resolve('bin/toolbox-al.ts')

function run(dir: string, args: string[]) {
  const result = spawnSync(process.execPath, [bin, ...args], { cwd: dir, encoding: 'utf8', windowsHide: true })
  return { code: result.status, out: result.stdout ?? '', err: result.stderr ?? '' }
}

function project(): string {
  const dir = makeRepo()
  const init = run(dir, ['init'])
  assert.equal(init.code, 0, init.err)
  return dir
}

function withDb<T>(dir: string, fn: (db: ReturnType<typeof openDb>) => T): T {
  const db = openDb(join(dir, '.toolbox-al', 'tracker.db'))
  try {
    return fn(db)
  } finally {
    db.close()
  }
}

test('end с причиной owner закрывает прогон и ревью не требует', () => {
  const dir = project()
  const started = run(dir, ['run', 'start', '--mode', 'plan'])
  assert.equal(started.code, 0, started.err)

  const ended = run(dir, ['run', 'end', 'RUN1', '--reason', 'owner'])
  assert.equal(ended.code, 0, ended.err)
  assert.match(ended.out, /RUN1\s+закрыт · причина: владелец · ревью не было/)

  const show = run(dir, ['run', 'show'])
  assert.equal(show.code, 0, show.err)
  assert.match(show.out, /RUN1\s+закрыт .*ревью не было/)
  assert.match(show.out, /причина: владелец/)

  withDb(dir, (db) => {
    const record = getRunRecord(db, 'RUN1')!
    assert.equal(record.endReason, 'owner')
    assert.ok(record.endedAt, 'конец прогона записан')
    assert.equal(record.reviewRequired, false, 'остановка владельцем ревью не требует')
    assert.equal(reviewState(record, reviewOf(db, 'RUN1')), 'not_required')
  })
})

test('end с задачами требует ревью, а вердикт ok делает прогон готовым к релизу', () => {
  const dir = project()
  run(dir, ['run', 'start', '--mode', 'all'])

  const ended = run(dir, ['run', 'end', 'RUN1', '--reason', 'tasks'])
  assert.equal(ended.code, 0, ended.err)
  assert.match(ended.out, /RUN1\s+закрыт · причина: задачи · нужно ревью/)

  withDb(dir, (db) => {
    const record = getRunRecord(db, 'RUN1')!
    assert.equal(record.reviewRequired, true, 'прогон без остановки владельцем ревью требует')
    assert.equal(reviewState(record, reviewOf(db, 'RUN1')), 'needs_review')
  })

  const pending = run(dir, ['run', 'show'])
  assert.match(pending.out, /нужно ревью/)

  const reviewed = run(dir, ['run', 'review', 'RUN1', '--verdict', 'ok', '--as', 'reviewer'])
  assert.equal(reviewed.code, 0, reviewed.err)
  assert.match(reviewed.out, /RUN1\s+ревью: ok · готов к релизу/)

  const show = run(dir, ['run', 'show'])
  assert.match(show.out, /готов к релизу/)
  assert.doesNotMatch(show.out, /нужно ревью/)

  withDb(dir, (db) => {
    const record = getRunRecord(db, 'RUN1')!
    const review = reviewOf(db, 'RUN1')
    assert.equal(review?.verdict, 'ok')
    assert.equal(review?.actor, 'reviewer')
    assert.equal(reviewState(record, review), 'ready')
  })
})

test('повторный end закрытого прогона отвергается и не переписывает конец', () => {
  const dir = project()
  run(dir, ['run', 'start', '--mode', 'plan'])
  assert.equal(run(dir, ['run', 'end', 'RUN1', '--reason', 'tasks']).code, 0)

  const again = run(dir, ['run', 'end', 'RUN1', '--reason', 'owner'])
  assert.equal(again.code, 1)
  assert.match(again.err, /RUN1 уже закрыт/)
  assert.match(again.err, /второй run end не нужен/)

  withDb(dir, (db) => {
    const record = getRunRecord(db, 'RUN1')!
    assert.equal(record.endReason, 'tasks', 'причина конца осталась первой')
    assert.equal(record.reviewRequired, true)
  })
})

test('ревью с замечаниями требует описания и не делает прогон готовым', () => {
  const dir = project()
  run(dir, ['run', 'start', '--mode', 'plan'])
  assert.equal(run(dir, ['run', 'end', 'RUN1', '--reason', 'decision']).code, 0)

  const bare = run(dir, ['run', 'review', 'RUN1', '--verdict', 'found'])
  assert.equal(bare.code, 3)
  assert.match(bare.err, /--note/)

  const found = run(dir, ['run', 'review', 'RUN1', '--verdict', 'found', '--note', 'плавающий тест'])
  assert.equal(found.code, 0, found.err)
  assert.match(found.out, /ревью: found · ревью нашло замечания/)
  assert.match(found.out, /плавающий тест/)

  const show = run(dir, ['run', 'show'])
  assert.match(show.out, /ревью нашло замечания/)
  assert.doesNotMatch(show.out, /готов к релизу/)
})

test('ревью открытого прогона и неизвестная причина конца — отказы', () => {
  const dir = project()
  run(dir, ['run', 'start', '--mode', 'plan'])

  const early = run(dir, ['run', 'review', 'RUN1', '--verdict', 'ok'])
  assert.equal(early.code, 1)
  assert.match(early.err, /ещё идёт/)

  const badReason = run(dir, ['run', 'end', 'RUN1', '--reason', 'отдых'])
  assert.equal(badReason.code, 3)
  assert.match(badReason.err, /owner, tasks или decision/)

  const noReason = run(dir, ['run', 'end', 'RUN1'])
  assert.equal(noReason.code, 3)
  assert.match(noReason.err, /run end RUN1 --reason/)

  // отказы ничего не закрыли: прогон всё ещё активный
  const show = run(dir, ['run', 'show'])
  assert.match(show.out, /идёт с/)
  withDb(dir, (db) => assert.equal(getRunRecord(db, 'RUN1')?.endedAt, null))
})

test('run show печатает активный прогон и последний закрытый рядом', () => {
  const dir = project()
  run(dir, ['run', 'start', '--mode', 'plan'])
  run(dir, ['run', 'end', 'RUN1', '--reason', 'tasks'])
  run(dir, ['run', 'review', 'RUN1', '--verdict', 'ok'])
  run(dir, ['run', 'start', '--mode', 'all', '--approve'])

  const show = run(dir, ['run', 'show'])
  assert.equal(show.code, 0, show.err)

  const [active, closed] = show.out.trim().split('\n')
  assert.match(active, /RUN2\s+идёт с/)
  assert.match(closed, /RUN1\s+закрыт/)
  assert.match(closed, /готов к релизу/)
})

test('run next отдаёт следующую задачу и остаток', () => {
  const dir = project()
  run(dir, ['request', 'add', 'Очередь'])
  run(dir, ['feature', 'add', 'Фича', '--request', 'R1'])
  run(dir, ['stage', 'add', 'F1', 'Этап', '--goal', 'g', '--appetite', '1 день'])
  run(dir, ['stage', 'activate', 'F1.S1'])
  run(dir, ['task', 'add', 'F1.S1', 'Шаг', '--dod', 'a', '--skill', 'backend', '--scope', 'src/**'])
  run(dir, ['run', 'start', '--mode', 'plan', '--request', 'R1'])

  const next = run(dir, ['run', 'next'])
  assert.equal(next.code, 0, next.err)
  assert.match(next.out, /F1\.S1-1/)
  assert.match(next.out, /осталось: 1 из 1/)

  const show = run(dir, ['run', 'show'])
  assert.match(show.out, /дальше: F1\.S1-1/)
})
