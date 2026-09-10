import "./config";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { projectRoot } from "./config";
import { schema } from "./schema";

const databasePath = resolve(projectRoot, process.env.DATABASE_PATH ?? "apps/api/data/demo.sqlite");

mkdirSync(dirname(databasePath), { recursive: true });

export const sqlite = new Database(databasePath);
sqlite.pragma("journal_mode = WAL");
sqlite.pragma("foreign_keys = ON");

export const db = drizzle(sqlite, { schema });

export function initializeDatabase() {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS user (
      id text PRIMARY KEY NOT NULL,
      name text NOT NULL,
      email text NOT NULL UNIQUE,
      email_verified integer NOT NULL DEFAULT 0,
      image text,
      created_at integer NOT NULL,
      updated_at integer NOT NULL
    );
    CREATE TABLE IF NOT EXISTS session (
      id text PRIMARY KEY NOT NULL,
      expires_at integer NOT NULL,
      token text NOT NULL UNIQUE,
      created_at integer NOT NULL,
      updated_at integer NOT NULL,
      ip_address text,
      user_agent text,
      user_id text NOT NULL REFERENCES user(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS account (
      id text PRIMARY KEY NOT NULL,
      account_id text NOT NULL,
      provider_id text NOT NULL,
      user_id text NOT NULL REFERENCES user(id) ON DELETE CASCADE,
      access_token text,
      refresh_token text,
      id_token text,
      access_token_expires_at integer,
      refresh_token_expires_at integer,
      scope text,
      password text,
      created_at integer NOT NULL,
      updated_at integer NOT NULL
    );
    CREATE TABLE IF NOT EXISTS verification (
      id text PRIMARY KEY NOT NULL,
      identifier text NOT NULL,
      value text NOT NULL,
      expires_at integer NOT NULL,
      created_at integer,
      updated_at integer
    );
    CREATE TABLE IF NOT EXISTS access_grant (
      id text PRIMARY KEY NOT NULL,
      user_id text NOT NULL REFERENCES user(id) ON DELETE CASCADE,
      role text NOT NULL CHECK (role IN ('owner', 'manager', 'technician')),
      branch_id text,
      granted_by_user_id text REFERENCES user(id) ON DELETE SET NULL,
      granted_at integer NOT NULL,
      revoked_at integer
    );
    CREATE INDEX IF NOT EXISTS access_grant_active_user_idx ON access_grant(user_id, revoked_at);
    CREATE TABLE IF NOT EXISTS liff_identity (
      line_user_id text PRIMARY KEY NOT NULL,
      user_id text NOT NULL REFERENCES user(id) ON DELETE CASCADE,
      display_name text NOT NULL,
      updated_at integer NOT NULL
    );
    CREATE TABLE IF NOT EXISTS liff_session (
      id text PRIMARY KEY NOT NULL,
      user_id text NOT NULL REFERENCES user(id) ON DELETE CASCADE,
      token text NOT NULL UNIQUE,
      expires_at integer NOT NULL,
      created_at integer NOT NULL
    );
    CREATE INDEX IF NOT EXISTS liff_session_token_idx ON liff_session(token, expires_at);
    CREATE TABLE IF NOT EXISTS liff_access_request (
      id text PRIMARY KEY NOT NULL,
      line_user_id text NOT NULL UNIQUE,
      display_name text NOT NULL,
      requested_at integer NOT NULL,
      approved_at integer,
      approved_by_user_id text REFERENCES user(id) ON DELETE SET NULL
    );
    CREATE TABLE IF NOT EXISTS alert_acknowledgement (
      id text PRIMARY KEY NOT NULL,
      iris_alert_id text NOT NULL UNIQUE,
      user_id text NOT NULL REFERENCES user(id) ON DELETE CASCADE,
      note text,
      created_at integer NOT NULL
    );
    CREATE TABLE IF NOT EXISTS audit_log (
      id text PRIMARY KEY NOT NULL,
      actor_user_id text REFERENCES user(id) ON DELETE SET NULL,
      action text NOT NULL,
      target text NOT NULL,
      detail text NOT NULL,
      created_at integer NOT NULL
    );
    CREATE TABLE IF NOT EXISTS alert_notification (
      id text PRIMARY KEY NOT NULL,
      iris_alert_id text NOT NULL,
      line_user_id text NOT NULL,
      branch_id text,
      machine_id text,
      severity text NOT NULL,
      title text NOT NULL,
      message text NOT NULL,
      evidence text NOT NULL DEFAULT '{}',
      status text NOT NULL CHECK (status IN ('sending', 'sent', 'failed')),
      cooldown_key text,
      attempted_at integer NOT NULL,
      delivered_at integer,
      error text,
      UNIQUE (iris_alert_id, line_user_id)
    );
    CREATE INDEX IF NOT EXISTS alert_notification_cooldown_idx ON alert_notification(cooldown_key, attempted_at);
    CREATE INDEX IF NOT EXISTS alert_notification_status_idx ON alert_notification(status, attempted_at);
    CREATE TABLE IF NOT EXISTS ai_settings (
      id text PRIMARY KEY NOT NULL DEFAULT 'default',
      base_url text NOT NULL,
      api_key_encrypted text,
      model text NOT NULL,
      system_prompt text NOT NULL,
      temperature integer NOT NULL DEFAULT 70,
      updated_by_user_id text REFERENCES user(id) ON DELETE SET NULL,
      updated_at integer NOT NULL,
      created_at integer NOT NULL
    );
    CREATE TABLE IF NOT EXISTS chat_message (
      id text PRIMARY KEY NOT NULL,
      thread_id text NOT NULL,
      user_id text NOT NULL REFERENCES user(id) ON DELETE CASCADE,
      role text NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
      content text NOT NULL,
      model text,
      created_at integer NOT NULL
    );
    CREATE INDEX IF NOT EXISTS chat_message_thread_idx ON chat_message(thread_id, created_at);
    CREATE INDEX IF NOT EXISTS chat_message_purge_idx ON chat_message(created_at);
  `);
}
