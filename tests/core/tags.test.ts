import test from 'node:test'
import assert from 'node:assert/strict'
import { RUN_VARIANTS, variantOf } from '../../src/core/tags.ts'
import type { Card } from '../../src/core/types.ts'

const cardWithTags = (tags: string[]): Card => ({ tags }) as Card

test('variantOf берёт первый тег в порядке new, improve, review', () => {
  assert.equal(variantOf(cardWithTags(['review', 'new']))?.tag, 'new')
  assert.equal(variantOf(cardWithTags(['review', 'improve']))?.tag, 'improve')
  assert.equal(variantOf(cardWithTags(['backend'])), null)
  assert.equal(RUN_VARIANTS.length, 3)
})
