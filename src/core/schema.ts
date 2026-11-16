import type { DatabaseSync } from 'node:sqlite'

export const SCHEMA_VERSION = 1

const DDL_V1 = `
create table if not exists meta (
  key   text primary key,
  value text not null
);

create table if not exists events (
  id      integer primary key autoincrement,
  at      text not null,
  type    text not null,
  actor   text not null,
  subject text not null,
  before  text,
  after   text,
  note    text
);
create index if not exists idx_events_subject on events(subject, id);

create table if not exists executors (
  id         text primary key,
  kind       text not null,
  skills     text not null,
  wip_limit  integer not null default 1,
  hand_size  integer not null default 5,
  session    text,
  last_seen  text
);

create table if not exists requests (
  id         text primary key,
  title      text not null,
  body       text not null,
  status     text not null,
  author     text not null,
  created_at text not null,
  review_at  text
);

create table if not exists features (
  id            text primary key,
  request_id    text references requests(id),
  name          text not null,
  rank          integer not null,
  status        text not null,
  appetite      text,
  review_policy text not null default 'auto',
  created_at    text not null
);

create table if not exists stages (
  id         text primary key,
  feature_id text not null references features(id),
  seq        integer not null,
  name       text not null,
  goal       text not null,
  appetite   text,
  status     text not null,
  acceptance text not null default 'auto'
);
create index if not exists idx_stages_feature on stages(feature_id, seq);

create table if not exists tasks (
  id          text primary key,
  stage_id    text references stages(id),
  title       text not null,
  kind        text not null default 'task',
  dod         text not null,
  check_cmd   text,
  size        text not null,
  size_reason text,
  skill       text not null,
  class       text not null,
  scope       text not null,
  status      text not null,
  holder      text,
  lease_until text,
  attempts    integer not null default 0,
  reason      text,
  created_at  text not null
);
create index if not exists idx_tasks_status on tasks(status);
create index if not exists idx_tasks_stage on tasks(stage_id);

create table if not exists deps (
  from_id text not null,
  to_id   text not null,
  primary key (from_id, to_id)
);

create table if not exists hand (
  executor_id text not null,
  position    integer not null,
  task_id     text not null,
  reserved_at text not null,
  primary key (executor_id, task_id)
);

create table if not exists questions (
  id             text primary key,
  addressee      text not null,
  text           text not null,
  options        text,
  subject_type   text not null,
  subject_id     text not null,
  deadline       text,
  timeout_policy text not null default 'block',
  status         text not null default 'pending',
  answer         text,
  answered_by    text,
  answered_at    text,
  created_at     text not null
);
create index if not exists idx_questions_addressee on questions(addressee, status);

create table if not exists reviews (
  id       integer primary key autoincrement,
  task_id  text not null,
  reviewer text not null,
  verdict  text not null,
  comments text,
  at       text not null
);
`

function currentVersion(db: DatabaseSync): number {
  db.exec('create table if not exists meta (key text primary key, value text not null)')
  const row = db.prepare("select value from meta where key = 'schemaVersion'").get() as { value: string } | undefined
  return row ? Number(row.value) : 0
}

export function migrate(db: DatabaseSync): number {
  const from = currentVersion(db)
  if (from >= SCHEMA_VERSION) return from

  db.exec('begin immediate')
  try {
    if (from < 1) db.exec(DDL_V1)
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
