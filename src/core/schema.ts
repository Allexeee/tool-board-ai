import type { DatabaseSync } from 'node:sqlite'

export const SCHEMA_VERSION = 1

/** Схема v1 из спецификации §13. Старые базы toolbox-al не мигрируются. */
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

create table cards (
  id text primary key,
  group_prefix text not null,
  group_seq integer not null,
  title text not null,
  body text not null default '',
  phase text not null default 'request',
  status text not null,
  skill text,
  importance integer,
  urgency integer,
  position integer,
  needs_merge integer not null default 1,
  review_required integer not null default 0,
  scope text not null default '[]',
  severity text,
  origin_card_id text,
  summary text,
  holder text,
  run_id text,
  branch text,
  attempt integer not null default 1,
  merge_commit text,
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
  at text not null
);
`

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

/** Создаёт схему v1; на актуальной базе ничего не делает. */
export function migrate(db: DatabaseSync): number {
  const from = schemaVersionOf(db)
  if (from >= SCHEMA_VERSION) return from

  db.exec('begin immediate')
  try {
    db.exec(DDL)
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
