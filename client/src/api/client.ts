import { apiErrorFromResponse } from '../api-error';

export function getCookie(name: string) {
  const prefix = `${encodeURIComponent(name)}=`;
  const entry = document.cookie.split(';').map(value => value.trim()).find(value => value.startsWith(prefix));
  if (!entry) return '';
  const value = entry.slice(prefix.length);
  try { return decodeURIComponent(value); } catch { return value; }
}

export async function api<T = any>(url: string, opts: RequestInit = {}): Promise<T> {
  const csrf = getCookie('agentdeck_csrf');
  const headers = new Headers(opts.headers);
  if (csrf && !headers.has('x-csrf-token')) headers.set('x-csrf-token', csrf);
  if (opts.body !== undefined && !(opts.body instanceof FormData) && !headers.has('content-type')) headers.set('content-type', 'application/json');
  const response = await fetch(url, { ...opts, headers, credentials: 'same-origin' });
  if (!response.ok) throw await apiErrorFromResponse(response);
  if (response.status === 204 || response.status === 205) return undefined as T;
  const text = await response.text();
  if (!text.trim()) return undefined as T;
  const contentType = response.headers.get('content-type') || '';
  if (!contentType.includes('json')) return text as T;
  try { return JSON.parse(text) as T; }
  catch { throw new Error('服务器返回了无效的 JSON 响应'); }
}
