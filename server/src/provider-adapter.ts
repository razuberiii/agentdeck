import type { ProviderStatus } from './provider-status.js';
import type { AgentProviderId } from './providers.js';

export type ProviderCapabilityKey =
  | 'authentication'
  | 'accountManagement'
  | 'persistentSessions'
  | 'streaming'
  | 'cancellation'
  | 'attachments'
  | 'modelSelection'
  | 'modelDiscovery'
  | 'quota'
  | 'sessionResume'
  | 'crossProfileResume';

export type ProviderCapability = {
  supported: boolean;
  reasonCode?: string;
  message?: string;
  details?: Record<string, any>;
};

export type ProviderCapabilities = Record<ProviderCapabilityKey, ProviderCapability>;

export interface ProviderAdapter {
  provider: AgentProviderId;
  getStatus(options?: Record<string, any>): Promise<ProviderStatus>;
  getCapabilities(): ProviderCapabilities;
  createSession(input: Record<string, any>): Promise<any>;
  loadSession(input: Record<string, any>): Promise<any>;
  rebindSession(input: Record<string, any>): Promise<any>;
  sendTurn(input: Record<string, any>): Promise<any>;
  cancelTurn(input: Record<string, any>): Promise<any>;
  getModels(input?: Record<string, any>): Promise<any>;
  setModel(input: Record<string, any>): Promise<any>;
  getQuota(input?: Record<string, any>): Promise<any>;
  startLogin(input?: Record<string, any>): Promise<any>;
  completeLogin(input: Record<string, any>): Promise<any>;
  cancelLogin(input: Record<string, any>): Promise<any>;
  logout(input: Record<string, any>): Promise<any>;
  deleteProfile(input: Record<string, any>): Promise<any>;
  getAccountIdentity(input?: Record<string, any>): Promise<any>;
  ensureRuntime(input?: Record<string, any>): Promise<any>;
}

const supported = (details?: Record<string, any>): ProviderCapability => ({ supported:true, details });
const unsupported = (reasonCode:string, message:string): ProviderCapability => ({ supported:false, reasonCode, message });

export function providerCapabilitiesFor(provider: AgentProviderId): ProviderCapabilities {
  if (provider === 'codex') {
    return {
      authentication:supported({ methods:['device'] }),
      accountManagement:supported(),
      persistentSessions:supported(),
      streaming:supported(),
      cancellation:supported(),
      attachments:supported({ imageInput:true, fileInput:false, fileTransport:'path' }),
      modelSelection:supported(),
      modelDiscovery:supported(),
      quota:supported(),
      sessionResume:supported(),
      crossProfileResume:supported(),
    };
  }
  if (provider === 'gemini') {
    return {
      authentication:supported({ methods:['oauth-personal','api_key','vertex'] }),
      accountManagement:supported(),
      persistentSessions:supported(),
      streaming:supported(),
      cancellation:supported(),
      attachments:supported({ imageInput:true, fileInput:true, fileTransport:'resource-link' }),
      modelSelection:supported(),
      modelDiscovery:supported({ source:'acp_config_options' }),
      quota:unsupported('quota_not_supported', 'Gemini CLI ACP 当前没有稳定的实时额度接口'),
      sessionResume:supported(),
      crossProfileResume:supported(),
    };
  }
  return {
    authentication:supported({ methods:['google_oauth'] }),
    accountManagement:supported(),
    persistentSessions:unsupported('capability_unknown', 'Antigravity 会话持久化能力无法稳定探测'),
    streaming:supported(),
    cancellation:supported(),
    attachments:supported({ imageInput:true, fileInput:false, fileTransport:'path' }),
    modelSelection:unsupported('model_selection_not_supported', 'Antigravity 当前未接入可选模型设置'),
    modelDiscovery:supported({ source:'cli_models_or_fallback' }),
    quota:unsupported('quota_not_supported', 'Antigravity CLI 当前没有稳定的实时额度接口'),
    sessionResume:unsupported('capability_unknown', 'Antigravity 会话恢复能力无法稳定探测'),
    crossProfileResume:unsupported('capability_unknown', 'Antigravity 跨账户恢复能力无法稳定探测'),
  };
}

export function unsupportedAdapterOperation(provider: AgentProviderId, operation:string) {
  const error:any = new Error(`${provider} adapter operation ${operation} is not implemented`);
  error.code = 'provider_adapter_operation_unsupported';
  error.provider = provider;
  error.operation = operation;
  error.supported = false;
  return error;
}

export function adapterOperationNames() {
  return [
    'getStatus',
    'getCapabilities',
    'createSession',
    'loadSession',
    'rebindSession',
    'sendTurn',
    'cancelTurn',
    'getModels',
    'setModel',
    'getQuota',
    'startLogin',
    'completeLogin',
    'cancelLogin',
    'logout',
    'deleteProfile',
    'getAccountIdentity',
    'ensureRuntime',
  ] as const;
}
