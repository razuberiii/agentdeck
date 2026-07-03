import type { ProviderStatus } from './provider-status.js';
import type { AgentProviderId, ProviderCapabilities } from './provider-registry.js';
export { providerCapabilitiesFor, type ProviderCapability, type ProviderCapabilityKey, type ProviderCapabilities } from './provider-registry.js';

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
