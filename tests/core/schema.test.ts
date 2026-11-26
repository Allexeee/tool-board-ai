import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { migrate, schemaVersionOf, SCHEMA_VERSION } from '../../src/core/schema.ts'

function columns(db: DatabaseSync, table: string): string[] {
  return (db.prepare(`pragma table_info(${table})`).all() as Array<{ name: string }>).map((row) => row.name)
}

test('новый файл получает схему v3 с полями spec/review и tags', () => {
  const db = new DatabaseSync(':memory:')
  assert.equal(migrate(db), 12)
  assert.equal(SCHEMA_VERSION, 12)
  assert.ok(columns(db, 'cards').includes('acceptance'))
  assert.ok(columns(db, 'cards').includes('legacy_ids'))
  assert.ok(columns(db, 'cards').includes('main_commit'))
  assert.ok(columns(db, 'cards').includes('owner_acceptance'))
  assert.ok(columns(db, 'cards').includes('owner_acceptance_manual'))
  assert.ok(columns(db, 'tags').includes('description'))
  assert.ok(columns(db, 'cards').includes('spec_rev'))
  assert.ok(columns(db, 'cards').includes('review_reopens'))
  assert.ok(columns(db, 'cards').includes('tags'))
  assert.ok(columns(db, 'reviews').includes('kind'))
  assert.ok(columns(db, 'reviews').includes('plan_compliance'))
  assert.ok(columns(db, 'reviews').includes('acceptance'))
  assert.ok(columns(db, 'runs').includes('review_mode'))
  assert.ok(columns(db, 'review_packages').includes('commits'))
})

test('база v10 получает поля приёмки владельцем', () => {
  const db = new DatabaseSync(':memory:')
  db.exec(`create table meta (key text primary key, value text not null);
    create table cards (id text primary key);
    insert into meta values ('schemaVersion', '10');
    insert into cards (id) values ('UI-1');`)

  assert.equal(migrate(db), 12)
  assert.ok(columns(db, 'cards').includes('owner_acceptance'))
  assert.ok(columns(db, 'cards').includes('owner_acceptance_manual'))
  const row = db
    .prepare('select owner_acceptance, owner_acceptance_manual from cards where id = ?')
    .get('UI-1') as { owner_acceptance: number; owner_acceptance_manual: number }
  assert.equal(row.owner_acceptance, 0)
  assert.equal(row.owner_acceptance_manual, 0)
})

test('база v7 получает таблицу пакетного ревью', () => {
  const db = new DatabaseSync(':memory:')
  db.exec(`create table meta (key text primary key, value text not null);
    insert into meta values ('schemaVersion', '7');`)

  assert.equal(migrate(db), 12)
  assert.ok(columns(db, 'review_packages').includes('findings'))
})

test('база v9 получает реестр тегов из карточек и служебных', () => {
  const db = new DatabaseSync(':memory:')
  db.exec(`create table meta (key text primary key, value text not null);
    create table cards (id text primary key, tags text not null default '[]');
    insert into meta values ('schemaVersion', '9');
    insert into cards (id, tags) values ('UI-1', '["ui","backend"]');`)

  assert.equal(migrate(db), 12)
  const names = (
    db.prepare('select name from tags order by name').all() as Array<{ name: string }>
  ).map((row) => row.name)
  assert.deepEqual(names, ['backend', 'idea', 'improve', 'new', 'review', 'ui'])
})

test('база v1 мигрирует без потери карточки', () => {
  const db = new DatabaseSync(':memory:')
  db.exec(`create table meta (key text primary key, value text not null);
    create table cards (id text primary key, body text not null default '', status text not null);
    create table reviews (id integer primary key autoincrement, card_id text not null,
      reviewer text not null, verdict text not null, note text, at text not null);
    create table runs (id text primary key, executor_id text not null, status text not null,
      created_at text not null, started_at text, ended_at text, lease_until text,
      review integer not null default 0, note text);
    insert into meta values ('schemaVersion', '1');
    insert into cards values ('UI-1', 'spec', 'ready');
    insert into reviews (card_id, reviewer, verdict, at) values ('UI-1', 'review', 'done', '2026-01-01');`)

  assert.equal(migrate(db), 12)
  assert.equal(schemaVersionOf(db), 12)
  assert.equal((db.prepare('select count(*) as n from cards').get() as { n: number }).n, 1)
  assert.equal(columns(db, 'cards').includes('spec_rev'), true)
  assert.equal(columns(db, 'cards').includes('tags'), true)
})

test('база v5 мигрирует acceptance в reviews', () => {
  const db = new DatabaseSync(':memory:')
  db.exec(`create table meta (key text primary key, value text not null);
    create table reviews (id integer primary key autoincrement, card_id text not null,
      reviewer text not null, verdict text not null, note text, at text not null,
      kind text not null default 'run', mode text, spec_rev integer, plan_compliance text);
    insert into meta values ('schemaVersion', '5');
    insert into reviews (card_id, reviewer, verdict, at) values ('UI-1', 'r', 'done', '2026-01-01');`)

  assert.equal(migrate(db), 12)
  assert.ok(columns(db, 'reviews').includes('acceptance'))
  const row = db.prepare('select acceptance from reviews').get() as {
    acceptance: string | null
  }
  assert.equal(row.acceptance, null)
})

test('база v6 мигрирует legacy_ids', () => {
  const db = new DatabaseSync(':memory:')
  db.exec(`create table meta (key text primary key, value text not null);
    create table cards (id text primary key);
    insert into meta values ('schemaVersion', '6');
    insert into cards (id) values ('UI-1');`)

  assert.equal(migrate(db), 12)
  assert.ok(columns(db, 'cards').includes('legacy_ids'))
  const row = db.prepare('select legacy_ids from cards where id = ?').get('UI-1') as {
    legacy_ids: string
  }
  assert.equal(row.legacy_ids, '[]')
})

test('база v2 мигрирует tags и помечает находки review', () => {
  const db = new DatabaseSync(':memory:')
  db.exec(`create table meta (key text primary key, value text not null);
    create table cards (id text primary key, origin_card_id text);
    insert into meta values ('schemaVersion', '2');
    insert into cards values ('UI-1', 'UI-9');
    insert into cards values ('UI-2', null);`)

  assert.equal(migrate(db), 12)
  const rows = db.prepare('select id, tags from cards order by id').all() as Array<{
    id: string
    tags: string
  }>
  assert.deepEqual(JSON.parse(rows[0].tags), ['review'])
  assert.deepEqual(JSON.parse(rows[1].tags), [])
})

test('база v11 получает cards.demons=0', () => {
  const db = new DatabaseSync(':memory:')
  db.exec(`create table meta (key text primary key, value text not null);
    create table cards (id text primary key);
    insert into meta values ('schemaVersion', '11');
    insert into cards (id) values ('UI-1');`)

  assert.equal(migrate(db), 12)
  assert.ok(columns(db, 'cards').includes('demons'))
  const row = db.prepare('select demons from cards where id = ?').get('UI-1') as {
    demons: number
  }
  assert.equal(row.demons, 0)
})
