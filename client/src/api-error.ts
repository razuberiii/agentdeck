export class ApiError extends Error {
  status: number;
  contentType: string;
  code?: string;
  detail?: string;
  userMessage: string;

  constructor(message: string, options: { status:number; contentType:string; code?:string; detail?:string; userMessage?:string }) {
    super(message);
    this.name = 'ApiError';
    this.status = options.status;
    this.contentType = options.contentType;
    this.code = options.code;
    this.detail = options.detail;
    this.userMessage = options.userMessage || message;
  }
}

export async function apiErrorFromResponse(response: Response) {
  const contentType = response.headers.get('content-type') || '';
  const status = response.status;
  if (contentType.includes('application/json')) {
    const payload = await response.json().catch(() => null);
    const nested = payload?.error && typeof payload.error === 'object' ? payload.error : payload;
    const code = typeof payload?.error === 'string' ? payload.error : nested?.code || nested?.error;
    const message = nested?.message || payload?.message || (typeof payload?.error === 'string' ? payload.error : response.statusText);
    const detail = nested?.detail || payload?.detail;
    return new ApiError([message, detail].filter(Boolean).join('：'), {
      status,
      contentType,
      code: code ? String(code) : undefined,
      detail: detail ? String(detail) : undefined,
      userMessage: [message, detail].filter(Boolean).join('：'),
    });
  }
  const text = await response.text().catch(() => '');
  const html = contentType.includes('text/html') || /<html[\s>]/i.test(text);
  if (html && [502, 503, 504].includes(status)) {
    console.warn('api gateway error', { status, contentType, sample: text.slice(0, 200).replace(/\s+/g, ' ') });
    return new ApiError('服务器暂时不可用，请稍后重试。', { status, contentType, userMessage:'服务器暂时不可用，请稍后重试。' });
  }
  if (html) {
    console.warn('api html error', { status, contentType, sample: text.slice(0, 200).replace(/\s+/g, ' ') });
    return new ApiError('服务器返回了不可显示的错误页面。', { status, contentType, userMessage:'服务器返回了不可显示的错误页面。' });
  }
  return new ApiError(text || response.statusText || `HTTP ${status}`, { status, contentType });
}
