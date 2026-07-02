export const CODEX_UNREADY_STATUSES = new Set([
  'draft',
  'authenticating',
  'verifying',
  'failed',
  'disabled',
]);

export type CodexProfileState = {
  id?: string | null;
  codex_home?: string | null;
  status?: string | null;
  active?: number | boolean | null;
  login?: { ok?: boolean } | null;
};

export type CodexPreflightResult =
  | { ok:true; profile:CodexProfileState }
  | { ok:false; code:string; message:string; safeDetail:string };

export function evaluateCodexProfileReadiness(profile:CodexProfileState | null):CodexPreflightResult {
  if (!profile?.id || !profile.codex_home || !profile.active) {
    return {
      ok:false,
      code:'codex_no_active_profile',
      message:'请先登录 Codex',
      safeDetail:'没有可用于创建会话的 active Codex Profile',
    };
  }
  const status = String(profile.status || 'authenticated');
  if (status !== 'authenticated' || CODEX_UNREADY_STATUSES.has(status)) {
    return {
      ok:false,
      code:'codex_profile_not_authenticated',
      message:'请先完成 Codex 登录',
      safeDetail:`当前 Codex Profile 状态为 ${status}`,
    };
  }
  if (!profile.login?.ok) {
    return {
      ok:false,
      code:'codex_profile_not_authenticated',
      message:'请先登录 Codex',
      safeDetail:'当前 Codex Profile 没有可用登录凭据',
    };
  }
  return { ok:true, profile };
}

type ActivationOptions = {
  target:CodexProfileState;
  previous:CodexProfileState | null;
  verifyCredentials:(target:CodexProfileState)=>Promise<boolean>;
  activateRuntime:(target:CodexProfileState)=>Promise<void>;
  commit:()=>Promise<void>;
  restoreRuntime:(previous:CodexProfileState)=>Promise<void>;
};

export async function activateCodexProfileAtomically(options:ActivationOptions) {
  if (!options.target.id || !options.target.codex_home) throw new Error('Codex profile is incomplete');
  if (!await options.verifyCredentials(options.target)) throw new Error('Codex profile has no usable credentials');
  let runtimeActivationStarted = false;
  try {
    runtimeActivationStarted = true;
    await options.activateRuntime(options.target);
    await options.commit();
  } catch (cause) {
    let restoreError:unknown = null;
    if (runtimeActivationStarted && options.previous?.id && options.previous.codex_home) {
      try {
        await options.restoreRuntime(options.previous);
      } catch (error) {
        restoreError = error;
      }
    }
    const message = cause instanceof Error ? cause.message : String(cause);
    const suffix = restoreError
      ? `; previous runtime restore failed: ${restoreError instanceof Error ? restoreError.message : String(restoreError)}`
      : '';
    throw new Error(`Codex runtime activation failed: ${message}${suffix}`, { cause });
  }
}
