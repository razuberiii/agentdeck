export type AgentProviderId = 'codex' | 'claude' | 'antigravity' | 'gemini';

export type ProviderCapabilityKey =
  | 'authentication'
  | 'accountManagement'
  | 'persistentSessions'
  | 'streaming'
  | 'partialStreaming'
  | 'toolCalls'
  | 'approvals'
  | 'askUserQuestion'
  | 'cancellation'
  | 'attachments'
  | 'imageInput'
  | 'modelSelection'
  | 'modelDiscovery'
  | 'quota'
  | 'sessionResume'
  | 'sessionFork'
  | 'crossProfileResume'
  | 'workspaceSelection'
  | 'diffArtifacts';

export type ProviderCapability = {
  supported: boolean;
  reasonCode?: string;
  message?: string;
  details?: Record<string, any>;
};

export type ProviderCapabilities = Record<ProviderCapabilityKey, ProviderCapability>;
export type ProviderExecutionCapabilities={canCreateSession:boolean;canContinueSession:boolean;supportsResume:boolean;supportsApprovals:boolean;supportsPlanMode:boolean;enforcedReadOnly:boolean;supportsAttachments:boolean;supportsModelSwitch:boolean;supportsAccountSwitch:boolean;supportsCancellation:boolean};

export type ProviderDefinition = {
  id: AgentProviderId;
  displayName: string;
  order: number;
  capabilities: ProviderCapabilities;
  accountManagement: boolean;
  modelSelection: boolean;
  quotaSupport: boolean;
};

const supported = (details?: Record<string, any>): ProviderCapability => ({ supported:true, details });
const unsupported = (reasonCode:string, message:string, details?: Record<string, any>): ProviderCapability => ({ supported:false, reasonCode, message, details });

const codexCapabilities: ProviderCapabilities = {
  authentication:supported({ methods:['device'] }),
  accountManagement:supported(),
  persistentSessions:supported(),
  streaming:supported(),
  partialStreaming:supported(),
  toolCalls:supported(),
  approvals:supported(),
  askUserQuestion:unsupported('capability_not_exposed', 'Codex 当前协议未作为独立 AskUserQuestion 能力暴露'),
  cancellation:supported(),
  attachments:supported({ imageInput:true, fileInput:false, fileTransport:'path' }),
  imageInput:supported(),
  modelSelection:supported(),
  modelDiscovery:supported(),
  quota:supported(),
  sessionResume:supported(),
  sessionFork:unsupported('capability_not_exposed', 'Codex 当前未在 AgentDeck 暴露 fork 会话'),
  crossProfileResume:supported(),
  workspaceSelection:supported(),
  diffArtifacts:supported(),
};

const claudeCapabilities: ProviderCapabilities = {
  authentication:supported({ methods:['official_cli','existing_cli_profile','setup_token','api_key'] }),
  accountManagement:supported(),
  persistentSessions:supported(),
  streaming:supported(),
  partialStreaming:supported(),
  toolCalls:supported(),
  approvals:supported({ callback:'canUseTool' }),
  askUserQuestion:supported(),
  cancellation:supported({ mechanism:'AbortController' }),
  attachments:supported({ imageInput:true, fileInput:true, fileTransport:'sdk_content_or_safe_path' }),
  imageInput:supported(),
  modelSelection:supported({ aliases:['default','sonnet','opus'], customModelId:true }),
  modelDiscovery:unsupported('model_discovery_not_supported', 'Claude Agent SDK 当前没有稳定的动态模型发现接口'),
  quota:unsupported('quota_not_supported', 'Claude Agent SDK usage/cost 不是账户剩余额度，AgentDeck 不伪造 Claude 额度'),
  sessionResume:supported({ source:'query_options_resume' }),
  sessionFork:supported({ source:'forkSession' }),
  crossProfileResume:supported({ rebind:'local_history_context' }),
  workspaceSelection:supported(),
  diffArtifacts:supported(),
};

const antigravityCapabilities: ProviderCapabilities = {
  authentication:supported({ methods:['google_oauth'] }),
  accountManagement:supported(),
  persistentSessions:unsupported('capability_unknown', 'Antigravity 会话持久化能力无法稳定探测'),
  streaming:supported(),
  partialStreaming:supported(),
  toolCalls:supported(),
  approvals:unsupported('approval_protocol_not_available', 'Antigravity CLI 当前未提供稳定审批协议'),
  askUserQuestion:unsupported('ask_user_question_not_supported', 'Antigravity CLI 当前未提供稳定 AskUserQuestion 协议'),
  cancellation:supported(),
  attachments:supported({ imageInput:true, fileInput:false, fileTransport:'path' }),
  imageInput:supported(),
  modelSelection:unsupported('model_selection_not_supported', 'Antigravity 当前未接入可选模型设置'),
  modelDiscovery:supported({ source:'cli_models_or_fallback' }),
  quota:unsupported('quota_not_supported', 'Antigravity CLI 当前没有稳定的实时额度接口'),
  sessionResume:unsupported('capability_unknown', 'Antigravity 会话恢复能力无法稳定探测'),
  sessionFork:unsupported('capability_unknown', 'Antigravity fork 能力无法稳定探测'),
  crossProfileResume:unsupported('capability_unknown', 'Antigravity 跨账户恢复能力无法稳定探测'),
  workspaceSelection:supported(),
  diffArtifacts:supported(),
};

const geminiCapabilities: ProviderCapabilities = {
  authentication:supported({ methods:['oauth-personal','api_key','vertex'] }),
  accountManagement:supported(),
  persistentSessions:supported(),
  streaming:supported(),
  partialStreaming:supported(),
  toolCalls:supported(),
  approvals:supported(),
  askUserQuestion:unsupported('ask_user_question_not_supported', 'Gemini ACP 当前未作为独立 AskUserQuestion 能力暴露'),
  cancellation:supported(),
  attachments:supported({ imageInput:true, fileInput:true, fileTransport:'resource-link' }),
  imageInput:supported(),
  modelSelection:supported(),
  modelDiscovery:supported({ source:'acp_config_options' }),
  quota:unsupported('quota_not_supported', 'Gemini CLI ACP 当前没有稳定的实时额度接口'),
  sessionResume:supported(),
  sessionFork:unsupported('capability_not_exposed', 'Gemini ACP 当前未在 AgentDeck 暴露 fork 会话'),
  crossProfileResume:supported(),
  workspaceSelection:supported(),
  diffArtifacts:supported(),
};

export const PROVIDER_ORDER: AgentProviderId[] = ['codex', 'claude', 'antigravity', 'gemini'];

export const PROVIDER_DEFINITIONS: Record<AgentProviderId, ProviderDefinition> = {
  codex: { id:'codex', displayName:'Codex', order:0, capabilities:codexCapabilities, accountManagement:true, modelSelection:true, quotaSupport:true },
  claude: { id:'claude', displayName:'Claude Code', order:1, capabilities:claudeCapabilities, accountManagement:true, modelSelection:true, quotaSupport:false },
  antigravity: { id:'antigravity', displayName:'Antigravity', order:2, capabilities:antigravityCapabilities, accountManagement:true, modelSelection:false, quotaSupport:false },
  gemini: { id:'gemini', displayName:'Gemini', order:3, capabilities:geminiCapabilities, accountManagement:true, modelSelection:true, quotaSupport:false },
};

export function providerDefinition(id: AgentProviderId) {
  return PROVIDER_DEFINITIONS[id];
}

export function providerCapabilitiesFor(id: AgentProviderId) {
  return providerDefinition(id).capabilities;
}
export function providerExecutionCapabilitiesFor(id:AgentProviderId):ProviderExecutionCapabilities{
  const capabilities=providerCapabilitiesFor(id);
  return {canCreateSession:true,canContinueSession:capabilities.sessionResume.supported,supportsResume:capabilities.sessionResume.supported,supportsApprovals:capabilities.approvals.supported,supportsPlanMode:id!=='antigravity',enforcedReadOnly:id==='codex'||id==='gemini',supportsAttachments:capabilities.attachments.supported,supportsModelSwitch:capabilities.modelSelection.supported,supportsAccountSwitch:capabilities.accountManagement.supported,supportsCancellation:capabilities.cancellation.supported};
}

export function providerDisplayName(id: AgentProviderId) {
  return providerDefinition(id).displayName;
}

export function providerStatusArray<T extends { id: AgentProviderId }>(statuses: Record<AgentProviderId, T>) {
  return PROVIDER_ORDER.map(id => statuses[id]).filter(Boolean);
}

export function normalizeProvider(value: any): AgentProviderId | null {
  const v = String(value || '');
  return (PROVIDER_ORDER as readonly string[]).includes(v) ? v as AgentProviderId : null;
}
