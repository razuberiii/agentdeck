import type {Db} from './db.js';
import {assertSchema,runMigrations,type Migration} from './migration-runner.js';

const sharedSessionColumns={provider_id:"TEXT NOT NULL DEFAULT 'codex'",account_id:'TEXT',model_id:'TEXT',model_revision:'INTEGER NOT NULL DEFAULT 0',workspace_path:'TEXT',provider_session_id:'TEXT',archived_at:'INTEGER',provider_profile_id:'TEXT',provider_capabilities:'TEXT',provider_metadata:'TEXT',last_execution_account_id:'TEXT',current_upstream_account_id:'TEXT',account_snapshot_json:'TEXT',creator_profile_id:'TEXT',selected_profile_id:'TEXT',executing_profile_id:'TEXT',upstream_binding_profile_id:'TEXT'};
const webColumns={sessions:{archived:'INTEGER NOT NULL DEFAULT 0',model:'TEXT',...sharedSessionColumns},artifacts:{anchor_item_id:'TEXT',turn_id:'TEXT',relative_path:'TEXT',content_hash:'TEXT',modified_at:'INTEGER',operation:"TEXT NOT NULL DEFAULT 'created'"},codex_profiles:{status:"TEXT NOT NULL DEFAULT 'authenticated'",email:'TEXT',display_name:'TEXT',metadata_status:"TEXT NOT NULL DEFAULT 'pending'",metadata_error:'TEXT',metadata_updated_at:'INTEGER'},gemini_profiles:{status:"TEXT NOT NULL DEFAULT 'configured'",default_model_mode:"TEXT NOT NULL DEFAULT 'auto'",default_model:'TEXT'},agent_messages:{client_message_id:'TEXT',turn_id:'TEXT',original_text:'TEXT',attachments_json:'TEXT',status:'TEXT'}};
const runtimeColumns={sessions:{...sharedSessionColumns,provider:'TEXT',upstream_thread_id:'TEXT',upstream_generation:'TEXT',upstream_status:'TEXT',active_turn_id:'TEXT',last_sequence:'INTEGER NOT NULL DEFAULT 0',interruption_reason:'TEXT'},events:{sequence:'INTEGER',event_type:'TEXT',payload_json:'TEXT',created_at:'INTEGER',event_key:'TEXT'}};

const webMigration:Migration={version:2,name:'web_schema_v2',columns:webColumns,statements:[
  'CREATE INDEX IF NOT EXISTS auth_sessions_active ON auth_sessions(revoked_at,expires_at)',
  "CREATE TABLE IF NOT EXISTS antigravity_profiles (id TEXT PRIMARY KEY, name TEXT NOT NULL, home_dir TEXT NOT NULL UNIQUE, active INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'authenticated', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)",
  "CREATE TABLE IF NOT EXISTS provider_login_attempts (id TEXT PRIMARY KEY, provider TEXT NOT NULL, profile_id TEXT, temp_home TEXT, method_id TEXT, status TEXT NOT NULL, error TEXT, metadata_json TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)",
  'CREATE UNIQUE INDEX IF NOT EXISTS agent_messages_session_client_message ON agent_messages(session_id,client_message_id) WHERE client_message_id IS NOT NULL',
  'CREATE UNIQUE INDEX IF NOT EXISTS artifacts_turn_path_hash ON artifacts(session_id,turn_id,relative_path,content_hash)',
  'CREATE UNIQUE INDEX IF NOT EXISTS artifacts_turn_path_operation ON artifacts(session_id,turn_id,relative_path,operation)',
  "UPDATE sessions SET provider_id='codex' WHERE provider_id IS NULL OR provider_id=''",
  'UPDATE sessions SET provider_session_id=codex_thread_id WHERE provider_session_id IS NULL AND codex_thread_id IS NOT NULL',
  'UPDATE sessions SET workspace_path=project_dir WHERE workspace_path IS NULL',
  'UPDATE sessions SET model_id=model WHERE model_id IS NULL AND model IS NOT NULL',
  'UPDATE sessions SET archived_at=updated_at WHERE archived=1 AND archived_at IS NULL',
  "UPDATE gemini_profiles SET status='bootstrap' WHERE id='default' AND auth_type IS NULL AND status='configured'",
  "UPDATE gemini_profiles SET status='bootstrap',active=0 WHERE auth_type IS NULL AND name='Gemini Account' AND status='configured'",
  "UPDATE sessions SET status='interrupted' WHERE status='running'"
]};
const runtimeMigration:Migration={version:2,name:'runtime_schema_v2',columns:runtimeColumns,statements:[
  'CREATE TABLE IF NOT EXISTS accounts (id TEXT PRIMARY KEY, provider TEXT NOT NULL, codex_home TEXT, runtime_instance_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)',
  'CREATE TABLE IF NOT EXISTS runtime_instances (instance_id TEXT PRIMARY KEY, pid INTEGER, started_at INTEGER NOT NULL, heartbeat_at INTEGER NOT NULL)',
  "CREATE TABLE IF NOT EXISTS claude_profiles (id TEXT PRIMARY KEY, name TEXT NOT NULL, profile_dir TEXT NOT NULL UNIQUE, config_dir TEXT NOT NULL UNIQUE, type TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'not_configured', credential_summary TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)",
  'CREATE UNIQUE INDEX IF NOT EXISTS idx_events_session_sequence ON events(session_id,sequence)',
  'CREATE UNIQUE INDEX IF NOT EXISTS idx_events_session_key ON events(session_id,event_key)',
  'CREATE INDEX IF NOT EXISTS idx_events_session_type_sequence ON events(session_id,event_type,sequence)',
  'CREATE INDEX IF NOT EXISTS idx_sessions_upstream_thread_id ON sessions(upstream_thread_id)',
  'UPDATE sessions SET archived_at=updated_at WHERE archived=1 AND archived_at IS NULL'
]};

export async function migrateWebSchema(db:Db){await runMigrations(db,'web',[{version:1,name:'web_schema_baseline',statements:process.env.AGENTDECK_TEST_BAD_MIGRATION==='1'?['THIS IS INVALID SQL']:[]},webMigration]);await assertSchema(db,'web',Object.fromEntries(Object.entries(webColumns).map(([table,columns])=>[table,Object.keys(columns)])));}
export async function migrateRuntimeSchema(db:Db){await runMigrations(db,'runtime',[{version:1,name:'runtime_schema_baseline',statements:process.env.AGENTDECK_TEST_BAD_MIGRATION==='1'?['THIS IS INVALID SQL']:[]},runtimeMigration]);await assertSchema(db,'runtime',Object.fromEntries(Object.entries(runtimeColumns).map(([table,columns])=>[table,Object.keys(columns)])));}
export const WEB_SCHEMA_VERSION=2,RUNTIME_SCHEMA_VERSION=2;
