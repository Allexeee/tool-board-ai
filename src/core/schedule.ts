import { UserError } from '../cli/errors.ts'

export type Schedule =
  | { kind: 'daily'; time: { h: number; m: number } }
  | { kind: 'weekly'; time: { h: number; m: number }; days: number[] }
  | { kind: 'every'; time: { h: number; m: number }; everyDays: number }

function parseTime(text: string): { h: number; m: number } {
  const match = /^(\d{1,2}):(\d{2})$/.exec(text)
  if (!match) throw new UserError(3, `расписание: время должно быть HH:MM, получено ${text}`)

  const h = Number(match[1])
  const m = Number(match[2])
  if (h > 23 || m > 59) throw new UserError(3, `расписание: время вне суток: ${text}`)

  return { h, m }
}

export function parseSchedule(text: string): Schedule {
  const parts = text.trim().split(/\s+/)

  if (parts[0] === 'daily' && parts[1]) {
    return { kind: 'daily', time: parseTime(parts[1]) }
  }

  if (parts[0] === 'weekly' && parts[1] && parts[2]) {
    const days = parts[1].split(',').map((day) => Number(day))
    if (days.some((day) => !Number.isInteger(day) || day < 0 || day > 6)) {
      throw new UserError(3, `расписание: дни недели от 0 до 6, получено ${parts[1]}`)
    }
    return { kind: 'weekly', time: parseTime(parts[2]), days }
  }

  const every = /^every (\d+)d$/.exec(`${parts[0] ?? ''} ${parts[1] ?? ''}`)
  if (every && parts[2]) {
    const everyDays = Number(every[1])
    if (everyDays < 1) throw new UserError(3, 'расписание: интервал должен быть больше нуля')
    return { kind: 'every', time: parseTime(parts[2]), everyDays }
  }

  throw new UserError(3, `расписание не разобрано: ${text}`)
}

function at(date: Date, time: { h: number; m: number }): Date {
  const copy = new Date(date)
  copy.setHours(time.h, time.m, 0, 0)
  return copy
}

export function nextRun(schedule: Schedule, from: Date): Date {
  if (schedule.kind === 'daily') {
    const today = at(from, schedule.time)
    return today > from ? today : at(new Date(from.getTime() + 86_400_000), schedule.time)
  }

  if (schedule.kind === 'weekly') {
    for (let offset = 0; offset <= 7; offset++) {
      const day = new Date(from.getTime() + offset * 86_400_000)
      if (!schedule.days.includes(day.getDay())) continue
      const candidate = at(day, schedule.time)
      if (candidate > from) return candidate
    }
    return at(new Date(from.getTime() + 7 * 86_400_000), schedule.time)
  }

  return at(new Date(from.getTime() + schedule.everyDays * 86_400_000), schedule.time)
}

function minutes(text: string): number {
  const { h, m } = parseTime(text)
  return h * 60 + m
}

export function inWindow(window: string | null, at: Date): boolean {
  if (!window) return true

  const [start, end] = window.split('-')
  const from = minutes(start)
  const to = minutes(end)
  const now = at.getHours() * 60 + at.getMinutes()

  if (from === to) return true
  if (from < to) return now >= from && now < to
  return now >= from || now < to
}
