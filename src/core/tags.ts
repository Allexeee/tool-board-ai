import type { Card } from './types.ts'

/** Три варианта забега: тег карточки и подпись. */
export const RUN_VARIANTS = [
  { tag: 'new', label: 'НОВОЕ' },
  { tag: 'improve', label: 'УЛУЧШЕНИЕ' },
  { tag: 'review', label: 'ПОСЛЕ РЕВЬЮ' },
] as const

export type RunVariant = (typeof RUN_VARIANTS)[number]

/** Первый вариантный тег в порядке new → improve → review. */
export function variantOf(card: Card): RunVariant | null {
  for (const variant of RUN_VARIANTS) {
    if (card.tags.includes(variant.tag)) return variant
  }
  return null
}

export function isVariantTag(tag: string): boolean {
  return RUN_VARIANTS.some((variant) => variant.tag === tag)
}
