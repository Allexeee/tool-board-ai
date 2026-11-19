import { closeSync, openSync, rmSync } from 'node:fs'
import { UserError } from '../cli/errors.ts'

const LOCK_TIMEOUT_MS = 2000
const LOCK_RETRY_MS = 25

/** Сон на главном потоке: в Node Atomics.wait разрешён, в браузере — нет. */
function sleep(ms: number): void {
  const sab = new SharedArrayBuffer(4)
  Atomics.wait(new Int32Array(sab), 0, 0, ms)
}

/**
 * Блокировка по файлу: `openSync(lock, 'wx')` создаёт файл только если его нет.
 * Пока файл существует, другой процесс ждёт и пересоздаёт попытку. Спустя
 * ~2 секунды ожидания бросает ошибку, чтобы append не висел бесконечно.
 */
export function withFileLock<T>(lockPath: string, fn: () => T): T {
  const deadline = Date.now() + LOCK_TIMEOUT_MS
  let fd: number | null = null

  for (;;) {
    try {
      fd = openSync(lockPath, 'wx')
      break
    } catch (error) {
      if ((error as { code?: string }).code !== 'EEXIST') throw error
      if (Date.now() >= deadline) {
        throw new UserError(3, `таймаут блокировки: ${lockPath} занят`)
      }
      sleep(Math.min(LOCK_RETRY_MS, deadline - Date.now()))
    }
  }

  try {
    return fn()
  } finally {
    if (fd !== null) closeSync(fd)
    try {
      rmSync(lockPath)
    } catch {
      // файл уже снят — не ошибка
    }
  }
}
