import type { PermissionMode, SDKMessage } from '@anthropic-ai/claude-agent-sdk';

export type ClaudeProfileType = 'official_cli' | 'existing_cli' | 'setup_token' | 'api_key';
export type ClaudeProfileStatus =
  | 'not_installed'
  | 'not_configured'
  | 'authenticated'
  | 'invalid_credentials'
  | 'runtime_unavailable'
  | 'capability_limited';

export type ClaudeProfile = {
  id: string;
  name: string;
  profileDir: string;
  configDir: string;
  type: ClaudeProfileType;
  active: boolean;
  status: ClaudeProfileStatus;
  credentialSummary?: string | null;
  createdAt: number;
  updatedAt: number;
};

export type ClaudeTurnInput = {
  localSessionId: string;
  cwd: string;
  text: string;
  input: any[];
  model?: string | null;
  permissionMode: PermissionMode;
  resume?: string | null;
  profile: ClaudeProfile;
  turnId: string;
  segmentId: string;
  clientMessageId: string;
  messageId: string;
  retryOf: string;
};

export type ClaudeCanonicalEvent =
  | { eventType: string; payload: any; persistDelta?: boolean }
  | null;

export type ClaudeSdkMessage = SDKMessage;
