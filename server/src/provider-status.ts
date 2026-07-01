export type ProviderId = 'codex' | 'gemini' | 'antigravity';
export type ProviderAvailability = 'checking' | 'ready' | 'unavailable' | 'error';
export type ProviderAuth = 'checking' | 'authenticated' | 'unauthenticated' | 'authenticating' | 'unknown' | 'not_applicable' | 'error';

export type ProviderStatus = {
  provider: ProviderId;
  id: ProviderId;
  displayName: string;
  availability: ProviderAvailability;
  auth: ProviderAuth;
  accountSummary: {
    profileId?: string;
    providerAccountId?: string;
    email?: string;
    displayName?: string;
    authType?: string;
  } | null;
  account: {
    id?: string;
    email?: string;
    displayName?: string;
    profileId?: string;
    authType?: string;
  } | null;
  version: string | null;
  activeProfileId: string | null;
  canCreateSession: boolean;
  canContinueSession: boolean;
  canManageAccounts: boolean;
  canLogout: boolean;
  canQueryQuota: boolean;
  canListModels: boolean;
  canSelectModel: boolean;
  capabilities: Record<string, any>;
  reasonCode: string | null;
  message: string | null;
  checkedAt: string;
  ok: boolean;
  installed: boolean;
  error: string | null;
  installHint?: string;
  command?: string;
};

type ProviderStatusInput = {
  provider: ProviderId;
  displayName: string;
  cliStatus?: any;
  auth: ProviderAuth;
  account?: ProviderStatus['account'];
  activeProfileId?: string | null;
  canCreateSession?: boolean;
  canContinueSession?: boolean;
  canManageAccounts?: boolean;
  canLogout?: boolean;
  canQueryQuota?: boolean;
  canListModels?: boolean;
  canSelectModel?: boolean;
  capabilities?: Record<string, any>;
  reasonCode?: string | null;
  message?: string | null;
  installHint?: string;
  command?: string;
  checkedAt?: string;
};

export function providerStatus(input: ProviderStatusInput): ProviderStatus {
  const cli = input.cliStatus || {};
  const installed = !!cli.ok;
  const availability: ProviderAvailability = cli.ok ? 'ready' : cli.error ? 'unavailable' : 'checking';
  const message = input.message ?? (availability === 'ready' ? null : String(cli.error || `${input.displayName} CLI 不可用`));
  const version = cli.version ? String(cli.version) : null;
  const canCreateSession = input.canCreateSession ?? (availability === 'ready' && input.auth === 'authenticated');
  const canListModels = input.canListModels ?? availability === 'ready';
  const accountSummary = input.account ? {
    profileId: input.account.profileId || input.account.id,
    providerAccountId: input.account.id,
    email: input.account.email,
    displayName: input.account.displayName,
    authType: input.account.authType,
  } : null;
  return {
    provider: input.provider,
    id: input.provider,
    displayName: input.displayName,
    availability,
    auth: input.auth,
    accountSummary,
    account: input.account || null,
    version,
    activeProfileId: input.activeProfileId || null,
    canCreateSession,
    canContinueSession: input.canContinueSession ?? canCreateSession,
    canManageAccounts: input.canManageAccounts ?? true,
    canLogout: input.canLogout ?? input.auth === 'authenticated',
    canQueryQuota: input.canQueryQuota ?? input.provider === 'codex',
    canListModels,
    canSelectModel: input.canSelectModel ?? canListModels,
    capabilities: input.capabilities || {},
    reasonCode: input.reasonCode || null,
    message,
    checkedAt: input.checkedAt || new Date().toISOString(),
    ok: installed,
    installed,
    error: availability === 'ready' ? null : message,
    installHint: input.installHint,
    command: input.command,
  };
}

export function providerAuthLabel(auth?: ProviderAuth, availability?: ProviderAvailability) {
  if (availability === 'unavailable') return '服务不可用';
  if (availability === 'error') return '状态异常';
  return ({
    checking: '正在检查',
    authenticated: '已登录',
    unauthenticated: '未登录',
    authenticating: '正在登录',
    unknown: '状态未知',
    not_applicable: '无需登录',
    error: '状态异常',
  } as Record<string, string>)[String(auth || 'unknown')] || '状态未知';
}

export function extractGeminiModelOptions(source: any) {
  const options = Array.isArray(source)
    ? source
    : Array.isArray(source?.configOptions)
      ? source.configOptions
      : [];
  const modelConfigOptions = options.filter((opt:any) => {
    const text = `${opt?.category || ''} ${opt?.id || ''} ${opt?.name || ''} ${opt?.title || ''}`.toLowerCase();
    return text.includes('model');
  });
  const models:any[] = [];
  for (const opt of modelConfigOptions) {
    const values = Array.isArray(opt?.values) ? opt.values
      : Array.isArray(opt?.options) ? opt.options
      : Array.isArray(opt?.items) ? opt.items
      : Array.isArray(opt?.choices) ? opt.choices
      : [];
    for (const value of values) {
      const id = typeof value === 'string' ? value : String(value?.id || value?.value || value?.model || value?.name || '');
      if (!id) continue;
      models.push({
        id,
        model: id,
        actualModel: id,
        displayName: typeof value === 'string' ? value : String(value?.label || value?.title || value?.displayName || value?.name || id),
        description: typeof value === 'string' ? '' : String(value?.description || ''),
        hidden: false,
        isDefault: !!(value?.selected || value?.default || opt?.value === id || opt?.currentValue === id),
        inputModalities: [],
        upgrade: null,
      });
    }
  }
  const legacy = Array.isArray(source?.models) ? source.models
    : Array.isArray(source?.availableModels) ? source.availableModels
    : [];
  for (const value of legacy) {
    const id = typeof value === 'string' ? value : String(value?.id || value?.model || value?.name || '');
    if (!id) continue;
    models.push({
      id,
      model: id,
      actualModel: id,
      displayName: typeof value === 'string' ? value : String(value?.displayName || value?.name || id),
      description: typeof value === 'string' ? '' : String(value?.description || ''),
      hidden: false,
      isDefault: !!(value?.selected || value?.default || source?.currentModel === id),
      inputModalities: [],
      upgrade: null,
    });
  }
  const seen = new Set<string>();
  return models.filter(model => {
    const key = String(model.id);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
