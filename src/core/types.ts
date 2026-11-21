export type CardPhase = 'request' | 'task'

export type CardStatus =
  | 'new'
  | 'shaping'
  | 'approval'
  | 'waiting'
  | 'ready'
  | 'booked'
  | 'in_progress'
  | 'blocked'
  | 'review'
  | 'done'
  | 'cancelled'

export type Severity = 'critical' | 'important' | 'other'

export type ExecutorKind = 'human' | 'agent'

export type RunStatus = 'active' | 'ended' | 'cancelled' | 'lease_expired'

export type RunCardStatus =
  | 'booked'
  | 'in_progress'
  | 'blocked'
  | 'dropped'
  | 'done'
  | 'review'

export interface Run {
  id: string
  executorId: string
  status: RunStatus
  createdAt: string
  startedAt: string | null
  endedAt: string | null
  leaseUntil: string | null
  review: boolean
  note: string | null
}

export interface RunCard {
  runId: string
  cardId: string
  position: number
  status: RunCardStatus
}

export interface Executor {
  id: string
  kind: ExecutorKind
  skills: string[]
  runSize: number
  worktree: string | null
  lastSeen: string | null
}

/** Карточка из §3.1: запрос и задача — две фазы одной сущности. */
export interface Card {
  id: string
  group: string
  groupSeq: number
  title: string
  body: string
  acceptance: string
  phase: CardPhase
  status: CardStatus
  skill: string | null
  importance: number | null
  urgency: number | null
  position: number | null
  needsMerge: boolean
  reviewRequired: boolean
  scope: string[]
  severity: Severity | null
  originCardId: string | null
  summary: string | null
  holder: string | null
  runId: string | null
  branch: string | null
  attempt: number
  specRev: number
  reviewReopens: number
  mergeCommit: string | null
  inDev: boolean
  inMain: boolean
  revertedAt: string | null
  revertCommit: string | null
  waiveDeps: boolean
  leaseUntil: string | null
  previousHolder: string | null
  createdAt: string
  updatedAt: string
  shapedAt: string | null
  approvedAt: string | null
  doneAt: string | null
  cancelReason: string | null
  note: string | null
}

export interface RunSuggestion {
  executorId: string
  cards: Card[]
  group: string | null
}
