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
const runtimeMigration3:Migration={version:3,name:'runtime_antigravity_terminal_intents',statements:[
  "CREATE TABLE IF NOT EXISTS antigravity_terminal_intents (session_id TEXT PRIMARY KEY, turn_id TEXT NOT NULL, terminal TEXT NOT NULL, reason TEXT, client_message_id TEXT, assistant_item_json TEXT, terminal_payload_json TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, last_error TEXT)",
  'CREATE UNIQUE INDEX IF NOT EXISTS idx_antigravity_terminal_intents_turn ON antigravity_terminal_intents(session_id,turn_id)'
]};
const webMigration3:Migration={version:3,name:'web_antigravity_profile_table',statements:["CREATE TABLE IF NOT EXISTS antigravity_profiles (id TEXT PRIMARY KEY, name TEXT NOT NULL, home_dir TEXT NOT NULL UNIQUE, active INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)"]};
const webMigration4:Migration={version:4,name:'web_receipt_retry_lineage',columns:{antigravity_profiles:{status:"TEXT NOT NULL DEFAULT 'authenticated'"},message_receipts:{retry_of:'TEXT'}},statements:['CREATE INDEX IF NOT EXISTS message_receipts_retry_of ON message_receipts(session_id,retry_of)']};
const webMigration5:Migration={version:5,name:'web_atomic_retry_claims',statements:['CREATE TABLE IF NOT EXISTS message_retry_claims(session_id TEXT NOT NULL,retry_of TEXT NOT NULL,retry_client_message_id TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(session_id,retry_of),UNIQUE(session_id,retry_client_message_id))']};
const webMigration6:Migration={version:6,name:'web_turn_code_changes',statements:["CREATE TABLE IF NOT EXISTS turn_code_changes (session_id TEXT NOT NULL, turn_id TEXT NOT NULL, anchor_item_id TEXT, changes_json TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(session_id,turn_id))",'CREATE INDEX IF NOT EXISTS turn_code_changes_session_created ON turn_code_changes(session_id,created_at)']};

const webRequired={tables:{users:['id','username','password_hash'],auth_sessions:['id','token_hash','expires_at'],sessions:['id','status','provider_id','model_revision'],runtime_ingestion_cursors:['session_id','committed_sequence','runtime_generation'],artifacts:['id','session_id','operation'],artifact_baselines:['session_id','turn_id','manifest_json'],turn_code_changes:['session_id','turn_id','changes_json'],codex_profiles:['id','status'],gemini_profiles:['id','status','default_model_mode'],antigravity_profiles:['id','status'],provider_login_attempts:['id','provider','status'],agent_messages:['id','session_id','client_message_id','status'],message_receipts:['session_id','client_message_id','status','retry_of'],message_retry_claims:['session_id','retry_of','retry_client_message_id'],interactive_requests:['request_id','session_id','status'],plan_tasks:['plan_id','session_id','status']},indexes:['auth_sessions_active','agent_messages_session_client_message','artifacts_turn_path_operation','turn_code_changes_session_created','message_receipts_retry_of','interactive_requests_session_status','plan_tasks_session_status']};
const runtimeRequired={tables:{sessions:['id','status','provider_id','upstream_thread_id','last_sequence'],events:['session_id','sequence','event_type','event_key'],accounts:['id','provider'],runtime_instances:['instance_id','heartbeat_at'],claude_profiles:['id','profile_dir','status'],plan_tasks:['plan_id','session_id','status'],antigravity_terminal_intents:['session_id','turn_id','terminal','terminal_payload_json']},indexes:['idx_events_session_sequence','idx_events_session_key','idx_events_session_type_sequence','idx_sessions_upstream_thread_id','plan_tasks_session_status','idx_antigravity_terminal_intents_turn']};

export async function verifyWebSchema(db:Db){await assertSchema(db,'web',webRequired);}
export async function verifyRuntimeSchema(db:Db){await assertSchema(db,'runtime',runtimeRequired);}
export async function migrateWebSchema(db:Db){await runMigrations(db,'web',[{version:1,name:'web_schema_baseline',statements:process.env.AGENTDECK_TEST_BAD_MIGRATION==='1'?['THIS IS INVALID SQL']:[]},webMigration,webMigration3,webMigration4,webMigration5,webMigration6]);await verifyWebSchema(db);}
export async function migrateRuntimeSchema(db:Db){await runMigrations(db,'runtime',[{version:1,name:'runtime_schema_baseline',statements:process.env.AGENTDECK_TEST_BAD_MIGRATION==='1'?['THIS IS INVALID SQL']:[]},runtimeMigration,runtimeMigration3]);await verifyRuntimeSchema(db);}
export const WEB_SCHEMA_VERSION=6,RUNTIME_SCHEMA_VERSION=3;
