import { apiErrorFromResponse } from '../api-error';

export function getCookie(name: string) {
  return document.cookie.split('; ').find(x => x.startsWith(name + '='))?.split('=')[1] || '';
}

export async function api(url: string, opts: any = {}) {
  const csrf = getCookie('agentdeck_csrf');
  const headers: any = { 'x-csrf-token': csrf, ...(opts.headers || {}) };
  if (opts.body !== undefined && !(opts.body instanceof FormData) && !headers['content-type']) headers['content-type'] = 'application/json';
  const response = await fetch(url, { ...opts, headers, credentials: 'same-origin' });
  if (!response.ok) throw await apiErrorFromResponse(response);
  return response.json();
}
