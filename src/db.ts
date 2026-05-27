import { Pool } from 'pg';
import dotenv from 'dotenv';
import { ConnectorStatusMap, Energy, Mood, SessionRow, UserStateRow } from './types';

dotenv.config();

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required');

export const db = new Pool({
  connectionString,
  ssl: process.env.PGSSLMODE === 'disable' ? false : { rejectUnauthorized: false },
});

const DEFAULT_CONNECTORS: ConnectorStatusMap = {
  calendar: false,
  email: false,
  instagram: false,
  calendly: false,
  facebook: false,
};

export async function initDb() {
  await db.query(`
    create extension if not exists pgcrypto;

    create table if not exists users (
      id text primary key,
      timezone text,
      created_at timestamptz default now()
    );

    create table if not exists user_state (
      user_id text primary key references users(id) on delete cascade,
      timezone text,
      current_status text,
      current_energy text,
      current_mood text,
      current_task text,
      current_session_id text,
      updated_at timestamptz default now()
    );

    create table if not exists sessions (
      id text primary key default gen_random_uuid()::text,
      user_id text references users(id) on delete cascade,
      task_label text,
      status text not null,
      started_at timestamptz not null default now(),
      ended_at timestamptz,
      duration_min integer,
      source text default 'voice',
      metadata jsonb default '{}'::jsonb,
      created_at timestamptz default now()
    );
    create index if not exists idx_sessions_user_status on sessions(user_id, status);
    create index if not exists idx_sessions_user_started on sessions(user_id, started_at desc);

    create table if not exists energy_logs (
      id text primary key default gen_random_uuid()::text,
      user_id text references users(id) on delete cascade,
      energy_level text,
      mood text,
      logged_at timestamptz not null default now(),
      metadata jsonb default '{}'::jsonb
    );
    create index if not exists idx_energy_logs_user_logged on energy_logs(user_id, logged_at desc);

    create table if not exists visual_context (
      id text primary key default gen_random_uuid()::text,
      user_id text references users(id) on delete cascade,
      scene_type text,
      raw_description text,
      confidence numeric,
      inferred_status text,
      observed_at timestamptz not null default now(),
      metadata jsonb default '{}'::jsonb
    );
    create index if not exists idx_visual_user_observed on visual_context(user_id, observed_at desc);

    create table if not exists events (
      id text primary key default gen_random_uuid()::text,
      user_id text references users(id) on delete cascade,
      event_type text not null,
      payload jsonb,
      created_at timestamptz default now()
    );
    create index if not exists idx_events_user_created on events(user_id, created_at desc);

    create table if not exists connector_status (
      user_id text primary key references users(id) on delete cascade,
      calendar_enabled boolean default false,
      email_enabled boolean default false,
      instagram_enabled boolean default false,
      calendly_enabled boolean default false,
      facebook_enabled boolean default false,
      updated_at timestamptz default now()
    );

    create table if not exists connector_data_cache (
      id text primary key default gen_random_uuid()::text,
      user_id text references users(id) on delete cascade,
      connector_key text not null,
      cache_key text not null,
      payload jsonb,
      updated_at timestamptz default now()
    );
    create index if not exists idx_connector_cache_user_key on connector_data_cache(user_id, connector_key, cache_key);

    create table if not exists nudges_sent (
      id text primary key default gen_random_uuid()::text,
      user_id text references users(id) on delete cascade,
      nudge_type text not null,
      sent_at timestamptz default now()
    );
    create index if not exists idx_nudges_user_sent on nudges_sent(user_id, sent_at desc);
  `);
}

export async function ensureUser(userId: string, timezone: string) {
  await db.query(`insert into users(id, timezone) values ($1,$2) on conflict (id) do update set timezone=$2`, [userId, timezone]);
  await db.query(`
    insert into user_state(user_id, timezone)
    values ($1,$2)
    on conflict (user_id) do update set timezone=$2, updated_at=now()
  `, [userId, timezone]);
  await db.query(`
    insert into connector_status(user_id)
    values ($1)
    on conflict (user_id) do nothing
  `, [userId]);
}

export async function getUserState(userId: string): Promise<UserStateRow | null> {
  const { rows } = await db.query(`select * from user_state where user_id=$1`, [userId]);
  return rows[0] || null;
}

export async function updateUserState(userId: string, patch: Partial<{ timezone: string; current_status: string; current_energy: Energy; current_mood: Mood; current_task: string | null; current_session_id: string | null; }>) {
  const current = await getUserState(userId);
  const next = {
    timezone: patch.timezone ?? current?.timezone ?? 'UTC',
    current_status: patch.current_status ?? current?.current_status ?? null,
    current_energy: patch.current_energy ?? current?.current_energy ?? null,
    current_mood: patch.current_mood ?? current?.current_mood ?? null,
    current_task: patch.current_task ?? current?.current_task ?? null,
    current_session_id: patch.current_session_id ?? current?.current_session_id ?? null,
  };

  await db.query(`
    insert into user_state(user_id, timezone, current_status, current_energy, current_mood, current_task, current_session_id, updated_at)
    values ($1,$2,$3,$4,$5,$6,$7,now())
    on conflict (user_id)
    do update set timezone=$2, current_status=$3, current_energy=$4, current_mood=$5, current_task=$6, current_session_id=$7, updated_at=now()
  `, [userId, next.timezone, next.current_status, next.current_energy, next.current_mood, next.current_task, next.current_session_id]);
}

export async function createSession(userId: string, taskLabel: string, metadata: any = {}): Promise<SessionRow> {
  const { rows } = await db.query(`
    insert into sessions(user_id, task_label, status, metadata)
    values ($1,$2,'active',$3::jsonb)
    returning *
  `, [userId, taskLabel, JSON.stringify(metadata)]);
  return rows[0];
}

export async function getActiveSession(userId: string): Promise<SessionRow | null> {
  const { rows } = await db.query(`
    select * from sessions where user_id=$1 and status='active' order by started_at desc limit 1
  `, [userId]);
  return rows[0] || null;
}

export async function endActiveSession(userId: string): Promise<SessionRow | null> {
  const active = await getActiveSession(userId);
  if (!active) return null;
  const { rows } = await db.query(`
    update sessions
    set status='ended', ended_at=now(), duration_min=greatest(1, floor(extract(epoch from (now()-started_at))/60))
    where id=$1
    returning *
  `, [active.id]);
  return rows[0] || null;
}

export async function insertEnergyLog(userId: string, energy: Energy, mood: Mood = null, metadata: any = {}) {
  await db.query(`
    insert into energy_logs(user_id, energy_level, mood, metadata)
    values ($1,$2,$3,$4::jsonb)
  `, [userId, energy, mood, JSON.stringify(metadata)]);
}

export async function insertVisualContext(userId: string, sceneType: string, rawDescription: string, confidence: number, inferredStatus: string | null = null, metadata: any = {}) {
  await db.query(`
    insert into visual_context(user_id, scene_type, raw_description, confidence, inferred_status, metadata)
    values ($1,$2,$3,$4,$5,$6::jsonb)
  `, [userId, sceneType, rawDescription, confidence, inferredStatus, JSON.stringify(metadata)]);
}

export async function getLatestVisualContext(userId: string) {
  const { rows } = await db.query(`select * from visual_context where user_id=$1 order by observed_at desc limit 1`, [userId]);
  return rows[0] || null;
}

export async function insertEvent(userId: string, eventType: string, payload: any = {}) {
  await db.query(`insert into events(user_id, event_type, payload) values ($1,$2,$3::jsonb)`, [userId, eventType, JSON.stringify(payload)]);
}

export async function getConnectorStatus(userId: string): Promise<ConnectorStatusMap> {
  const { rows } = await db.query(`select * from connector_status where user_id=$1`, [userId]);
  const row = rows[0];
  if (!row) return DEFAULT_CONNECTORS;
  return {
    calendar: !!row.calendar_enabled,
    email: !!row.email_enabled,
    instagram: !!row.instagram_enabled,
    calendly: !!row.calendly_enabled,
    facebook: !!row.facebook_enabled,
  };
}

export async function upsertConnectorStatus(userId: string, patch: Partial<ConnectorStatusMap>) {
  const current = await getConnectorStatus(userId);
  const next = { ...current, ...patch };
  await db.query(`
    insert into connector_status(user_id, calendar_enabled, email_enabled, instagram_enabled, calendly_enabled, facebook_enabled, updated_at)
    values ($1,$2,$3,$4,$5,$6,now())
    on conflict (user_id)
    do update set calendar_enabled=$2, email_enabled=$3, instagram_enabled=$4, calendly_enabled=$5, facebook_enabled=$6, updated_at=now()
  `, [userId, next.calendar, next.email, next.instagram, next.calendly, next.facebook]);
}

export async function setConnectorCache(userId: string, connectorKey: string, cacheKey: string, payload: any) {
  await db.query(`
    delete from connector_data_cache where user_id=$1 and connector_key=$2 and cache_key=$3
  `, [userId, connectorKey, cacheKey]);
  await db.query(`
    insert into connector_data_cache(user_id, connector_key, cache_key, payload, updated_at)
    values ($1,$2,$3,$4::jsonb,now())
  `, [userId, connectorKey, cacheKey, JSON.stringify(payload)]);
}

export async function getConnectorCache(userId: string, connectorKey: string, cacheKey: string) {
  const { rows } = await db.query(`
    select * from connector_data_cache where user_id=$1 and connector_key=$2 and cache_key=$3 order by updated_at desc limit 1
  `, [userId, connectorKey, cacheKey]);
  return rows[0]?.payload || null;
}

export async function getTodaySummary(userId: string) {
  const { rows } = await db.query(`
    select count(*)::int as sessions, coalesce(sum(duration_min),0)::int as total_minutes
    from sessions
    where user_id=$1 and started_at::date = current_date
  `, [userId]);
  return rows[0] || { sessions: 0, total_minutes: 0 };
}

export async function getRecentSessions(userId: string, limit = 30) {
  const { rows } = await db.query(`
    select * from sessions where user_id=$1 and status='ended' order by started_at desc limit $2
  `, [userId, limit]);
  return rows;
}

export async function getRecentEnergy(userId: string, limit = 20) {
  const { rows } = await db.query(`
    select * from energy_logs where user_id=$1 order by logged_at desc limit $2
  `, [userId, limit]);
  return rows;
}

export async function recordNudge(userId: string, nudgeType: string) {
  await db.query(`insert into nudges_sent(user_id, nudge_type) values ($1,$2)`, [userId, nudgeType]);
}

export async function wasNudgeSentRecently(userId: string, nudgeType: string, minutes: number) {
  const { rows } = await db.query(`
    select 1 from nudges_sent
    where user_id=$1 and nudge_type=$2 and sent_at > now() - ($3 || ' minutes')::interval
    limit 1
  `, [userId, nudgeType, String(minutes)]);
  return rows.length > 0;
}