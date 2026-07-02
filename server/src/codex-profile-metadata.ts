export type CodexProfileMetadata = {
  email:string | null;
  displayName:string | null;
};

export type CodexProfileMetadataResolution =
  | (CodexProfileMetadata & { status:'ready'; error:null })
  | (CodexProfileMetadata & { status:'failed'; error:string });

export function resolveCodexProfileMetadataFromAuth(auth:any):CodexProfileMetadataResolution {
  const metadata = extractCodexProfileMetadata(auth);
  if (metadata.email) return { ...metadata, status:'ready', error:null };
  return { ...metadata, status:'failed', error:'账户信息读取失败：认证凭据中未找到邮箱' };
}

export function extractCodexProfileMetadata(auth:any):CodexProfileMetadata {
  const payloads = [
    decodeJwtPayload(auth?.tokens?.id_token),
    decodeJwtPayload(auth?.tokens?.access_token),
  ].filter(Boolean);
  const sources = [...payloads, auth];
  let email:string|null = null;
  let displayName:string|null = null;
  for (const source of sources) {
    email ||= findEmail(source);
    displayName ||= findDisplayName(source);
  }
  return { email, displayName };
}

function decodeJwtPayload(value:any) {
  if (typeof value !== 'string' || value.length > 1024 * 1024) return null;
  const parts = value.split('.');
  if (parts.length !== 3 || !parts[1]) return null;
  try {
    const parsed = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function findEmail(value:any):string|null {
  if (!value) return null;
  if (typeof value === 'string') return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) ? value.slice(0, 254) : null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findEmail(item);
      if (found) return found;
    }
    return null;
  }
  if (typeof value === 'object') {
    for (const key of ['email','email_address','account_email','login']) {
      const found = findEmail(value[key]);
      if (found) return found;
    }
    for (const item of Object.values(value)) {
      const found = findEmail(item);
      if (found) return found;
    }
  }
  return null;
}

function findDisplayName(value:any):string|null {
  if (!value || typeof value !== 'object') return null;
  for (const key of ['name','display_name','displayName']) {
    const candidate = value[key];
    if (typeof candidate === 'string') {
      const cleaned = candidate.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 120);
      if (cleaned && !cleaned.includes('@')) return cleaned;
    }
  }
  const profile = value['https://api.openai.com/profile'];
  if (profile && profile !== value) return findDisplayName(profile);
  return null;
}
