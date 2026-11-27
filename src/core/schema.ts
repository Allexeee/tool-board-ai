import type { DatabaseSync } from 'node:sqlite'
import { nowIso } from './clock.ts'

export const SCHEMA_VERSION = 13

/** Схема v2: spec/acceptance, версии spec и режимы ревью. */
const DDL = `
create table meta (key text primary key, value text not null);

create table executors (
  id text primary key,
  kind text not null,
  skills text not null default '[]',
  run_size integer not null default 3,
  worktree text,
  last_seen text
);

create table groups (
  prefix text primary key,
  next_seq integer not null default 1,
  name text,
  created_at text not null
);

create table tags (
  name text primary key,
  description text,
  created_at text not null
);

create table cards (
  id text primary key,
  group_prefix text not null,
  group_seq integer not null,
  title text not null,
  body text not null default '',
  acceptance text not null default '',
  phase text not null default 'request',
  status text not null,
  skill text,
  importance integer,
  urgency integer,
  position integer,
  needs_merge integer not null default 1,
  review_required integer not null default 0,
  plan_waived integer not null default 0,
  scope text not null default '[]',
  tags text not null default '[]',
  legacy_ids text not null default '[]',
  severity text,
  origin_card_id text,
  summary text,
  holder text,
  run_id text,
  branch text,
  attempt integer not null default 1,
  spec_rev integer not null default 1,
  review_reopens integer not null default 0,
  merge_commit text,
  main_commit text,
  owner_acceptance integer not null default 0,
  owner_acceptance_manual integer not null default 0,
  demons integer not null default 0,
  in_dev integer not null default 0,
  in_main integer not null default 0,
  reverted_at text,
  revert_commit text,
  waive_deps integer not null default 0,
  lease_until text,
  previous_holder text,
  created_at text not null,
  updated_at text not null,
  shaped_at text,
  approved_at text,
  done_at text,
  cancel_reason text,
  note text
);
create index idx_cards_status on cards(status);
create index idx_cards_phase on cards(phase, position);

create table steps (
  card_id text not null references cards(id) on delete cascade,
  seq integer not null,
  text text not null,
  done integer not null default 0,
  done_at text,
  primary key (card_id, seq)
);

create table refs (
  id integer primary key autoincrement,
  card_id text not null references cards(id) on delete cascade,
  kind text not null,
  value text not null,
  title text,
  created_at text not null
);

create table deps (
  from_id text not null,
  to_id text not null,
  primary key (from_id, to_id)
);

create table discussion (
  id integer primary key autoincrement,
  card_id text not null references cards(id) on delete cascade,
  author text not null,
  kind text not null,
  text text not null,
  status text not null default 'open',
  answer_to integer,
  created_at text not null,
  answered_at text
);

create table events (
  id integer primary key autoincrement,
  at text not null,
  type text not null,
  actor text not null,
  subject text not null,
  before text,
  after text,
  note text
);
create index idx_events_subject on events(subject, id);

create table runs (
  id text primary key,
  executor_id text not null,
  status text not null,
  created_at text not null,
  started_at text,
  ended_at text,
  lease_until text,
  review integer not null default 0,
  review_mode text,
  note text
);
create unique index idx_runs_active on runs(executor_id)
  where status = 'active';

create table run_cards (
  run_id text not null references runs(id) on delete cascade,
  card_id text not null,
  position integer not null,
  status text not null,
  primary key (run_id, card_id)
);

create table run_notes (
  id integer primary key autoincrement,
  run_id text not null,
  actor text not null,
  text text not null,
  at text not null
);
create index idx_run_notes_run on run_notes(run_id, id);

create table decisions (
  id text primary key,
  card_id text,
  kind text not null,
  text text not null,
  status text not null default 'actual',
  superseded_by text,
  author text not null,
  created_at text not null,
  updated_at text not null
);

create table reviews (
  id integer primary key autoincrement,
  card_id text not null,
  reviewer text not null,
  verdict text not null,
  note text,
  at text not null,
  kind text not null default 'run',
  mode text,
  spec_rev integer,
  plan_compliance text,
  acceptance text
);

create table review_packages (
  id integer primary key autoincrement,
  at text not null,
  actor text not null,
  since text,
  verdict text not null,
  note text,
  cards text not null default '[]',
  commits text not null default '[]',
  findings text not null default '[]'
);
`

/** Добавляет поля v2 к существующей базе v1 без пересоздания таблиц. */
const MIGRATE_V1_TO_V2 = `
alter table cards add column acceptance text not null default '';
alter table cards add column spec_rev integer not null default 1;
alter table cards add column review_reopens integer not null default 0;
alter table reviews add column kind text not null default 'run';
alter table reviews add column mode text;
alter table reviews add column spec_rev integer;
alter table reviews add column plan_compliance text;
alter table runs add column review_mode text;
`

/** Теги; автотег находок ревью выполняется отдельно после проверки колонки. */
const MIGRATE_V2_TO_V3 = `
alter table cards add column tags text not null default '[]';
`

/** История проходов ревью: старый runs.note переезжает первой записью. */
const MIGRATE_V3_TO_V4 = `
create table run_notes (
  id integer primary key autoincrement,
  run_id text not null,
  actor text not null,
  text text not null,
  at text not null
);
create index idx_run_notes_run on run_notes(run_id, id);
`

/** Осознанный отказ от плана: маленькая задача без шагов. */
const MIGRATE_V4_TO_V5 = `
alter table cards add column plan_waived integer not null default 0;
`

/** Результат сверки acceptance в вердикте ревью. */
const MIGRATE_V5_TO_V6 = `
alter table reviews add column acceptance text;
`

/** Старые ID карточки после rekey: поиск и связь с ветками/коммитами. */
const MIGRATE_V6_TO_V7 = `
alter table cards add column legacy_ids text not null default '[]';
`

/** Проход пакетного ревью: карточки, коммиты, вердикт и находки одной записью. */
const MIGRATE_V7_TO_V8 = `
create table review_packages (
  id integer primary key autoincrement,
  at text not null,
  actor text not null,
  since text,
  verdict text not null,
  note text,
  cards text not null default '[]',
  commits text not null default '[]',
  findings text not null default '[]'
);
`

/** Пакетный релиз: коммит main, которым карточка попала в main через cherry-pick. */
const MIGRATE_V8_TO_V9 = `
alter table cards add column main_commit text;
`

/** Реестр тегов: свободные строки карточек получают словарь проекта. */
const MIGRATE_V9_TO_V10 = `
create table if not exists tags (
  name text primary key,
  description text,
  created_at text not null
);
`

/** Приёмка владельцем: флаг, ручной выбор и статус acceptance. */
const MIGRATE_V10_TO_V11 = `
alter table cards add column owner_acceptance integer not null default 0;
alter table cards add column owner_acceptance_manual integer not null default 0;
`

/** Демон: счётчик ручных понижений карточки. */
const MIGRATE_V11_TO_V12 = `
alter table cards add column demons integer not null default 0;
`

/** v12 → v13: шкала важности и срочности 1–5, старые нули становятся 1. */
const MIGRATE_V12_TO_V13 = `
update cards set importance = 1 where importance = 0;
update cards set urgency = 1 where urgency = 0;
`

/** Наполняет реестр служебными тегами и тегами существующих карточек. */
function seedTags(db: DatabaseSync): void {
  const hasCards = db
    .prepare("select 1 as found from sqlite_master where type = 'table' and name = 'cards'")
    .get()
  const hasTags = hasCards
    ? (db.prepare('pragma table_info(cards)').all() as Array<{ name: string }>).some(
        (row) => row.name === 'tags',
      )
    : false

  const insert = db.prepare(
    'insert or ignore into tags (name, description, created_at) values (?, null, ?)',
  )
  const at = nowIso()
  for (const name of ['new', 'improve', 'review', 'idea']) insert.run(name, at)

  if (!hasTags) return
  const rows = db
    .prepare('select distinct value from cards, json_each(cards.tags)')
    .all() as Array<{ value: string }>
  for (const row of rows) {
    if (row.value.trim() !== '') insert.run(row.value.trim().toLowerCase(), at)
  }
}

export function schemaVersionOf(db: DatabaseSync): number {
  const hasMeta = db
    .prepare("select 1 as found from sqlite_master where type = 'table' and name = 'meta'")
    .get()
  if (!hasMeta) return 0

  const row = db.prepare("select value from meta where key = 'schemaVersion'").get() as
    | { value: string }
    | undefined
  return row ? Number(row.value) : 0
}

/** Создаёт схему v2 или обновляет v1; на актуальной базе ничего не делает. */
export function migrate(db: DatabaseSync): number {
  const from = schemaVersionOf(db)
  if (from >= SCHEMA_VERSION) return from

  db.exec('begin immediate')
  try {
    if (from === 0) db.exec(DDL)
    else if (from === 1) {
      db.exec(MIGRATE_V1_TO_V2)
      db.exec(MIGRATE_V2_TO_V3)
      db.exec(MIGRATE_V3_TO_V4)
      db.exec(MIGRATE_V4_TO_V5)
    } else if (from === 2) {
      db.exec(MIGRATE_V2_TO_V3)
      db.exec(MIGRATE_V3_TO_V4)
      db.exec(MIGRATE_V4_TO_V5)
    } else if (from === 3) {
      db.exec(MIGRATE_V3_TO_V4)
      db.exec(MIGRATE_V4_TO_V5)
    } else if (from === 4) {
      db.exec(MIGRATE_V4_TO_V5)
    } else if (
      from !== 5 &&
      from !== 6 &&
      from !== 7 &&
      from !== 8 &&
      from !== 9 &&
      from !== 10 &&
      from !== 11 &&
      from !== 12
    ) {
      throw new Error(`нет миграции схемы ${from} → ${SCHEMA_VERSION}`)
    }

    // Синтетические базы тестов могут не иметь reviews/cards: тогда колонку некуда добавить.
    if (from >= 1 && from < 6) {
      const hasReviews = db
        .prepare("select 1 as found from sqlite_master where type = 'table' and name = 'reviews'")
        .get()
      if (hasReviews) db.exec(MIGRATE_V5_TO_V6)
    }
    if (from >= 1 && from < 7) {
      const hasCards = db
        .prepare("select 1 as found from sqlite_master where type = 'table' and name = 'cards'")
        .get()
      if (hasCards) db.exec(MIGRATE_V6_TO_V7)
    }
    if (from >= 1 && from < 8) db.exec(MIGRATE_V7_TO_V8)
    if (from >= 1 && from < 9) {
      const hasCards = db
        .prepare("select 1 as found from sqlite_master where type = 'table' and name = 'cards'")
        .get()
      if (hasCards) db.exec(MIGRATE_V8_TO_V9)
    }
    if (from < 10) {
      db.exec(MIGRATE_V9_TO_V10)
      seedTags(db)
    }
    if (from >= 1 && from < 11) {
      const hasCards = db
        .prepare("select 1 as found from sqlite_master where type = 'table' and name = 'cards'")
        .get()
      if (hasCards) db.exec(MIGRATE_V10_TO_V11)
    }
    if (from >= 1 && from < 12) {
      const hasCards = db
        .prepare("select 1 as found from sqlite_master where type = 'table' and name = 'cards'")
        .get()
      if (hasCards) db.exec(MIGRATE_V11_TO_V12)
    }
    if (from >= 1 && from < 13) {
      const columns = (
        db.prepare('pragma table_info(cards)').all() as Array<{ name: string }>
      ).map((row) => row.name)
      if (columns.includes('importance') && columns.includes('urgency')) {
        db.exec(MIGRATE_V12_TO_V13)
      }
    }

    if (from === 1 || from === 2) {
      const hasOrigin = (db.prepare('pragma table_info(cards)').all() as Array<{ name: string }>).some(
        (row) => row.name === 'origin_card_id',
      )
      if (hasOrigin) {
        db.exec(`update cards set tags = '["review"]' where origin_card_id is not null`)
      }
    }

    // Старый runs.note — первая запись истории. Таблицы runs может не быть
    // в синтетических базах тестов: тогда переносить нечего.
    if (from < 4) {
      const hasRuns = db
        .prepare("select 1 as found from sqlite_master where type = 'table' and name = 'runs'")
        .get()
      if (hasRuns) {
        db.exec(
          `insert into run_notes (run_id, actor, text, at)
           select id, 'system', note, coalesce(ended_at, started_at, created_at)
           from runs where note is not null and trim(note) != ''`,
        )
      }
    }
    db.prepare(
      "insert into meta (key, value) values ('schemaVersion', ?) " +
        'on conflict(key) do update set value = excluded.value',
    ).run(String(SCHEMA_VERSION))
    db.exec('commit')
  } catch (error) {
    db.exec('rollback')
    throw error
  }

  return SCHEMA_VERSION
}
