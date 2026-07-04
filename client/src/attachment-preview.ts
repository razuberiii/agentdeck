export type AttachmentPreviewInput = {
  name?: string;
  type?: string;
  mime?: string;
  previewUrl?: string;
  url?: string;
};

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'avif', 'heic', 'heif']);
const MARKDOWN_EXTENSIONS = new Set(['md', 'markdown', 'mdown', 'mkd']);
const TEXT_EXTENSIONS = new Set(['txt', 'text', 'log', 'csv', 'tsv', 'patch', 'diff', 'yaml', 'yml', 'xml', 'html', 'css', 'js', 'jsx', 'ts', 'tsx', 'mjs', 'py', 'go', 'rs', 'java', 'kt', 'swift', 'sh', 'sql']);
const ARCHIVE_EXTENSIONS = new Set(['zip', 'tar', 'gz', 'tgz', 'bz2', 'xz', '7z', 'rar']);

export function attachmentMime(attachment: AttachmentPreviewInput) {
  return String(attachment.type || attachment.mime || '').split(';', 1)[0].trim().toLowerCase();
}

export function attachmentExtension(attachment: AttachmentPreviewInput) {
  const source = String(attachment.name || attachment.url || attachment.previewUrl || '').split(/[?#]/, 1)[0].toLowerCase();
  const parts = source.split('/').pop()?.split('.') || [];
  if (parts.length < 2) return '';
  const ext = parts.pop() || '';
  if (ext === 'gz' && parts.at(-1) === 'tar') return 'tar.gz';
  return ext;
}

export function isImageAttachment(attachment: AttachmentPreviewInput) {
  const mime = attachmentMime(attachment);
  if (mime.startsWith('image/')) return true;
  return !mime && IMAGE_EXTENSIONS.has(attachmentExtension(attachment));
}

export function attachmentIconLabel(attachment: AttachmentPreviewInput) {
  const mime = attachmentMime(attachment);
  const ext = attachmentExtension(attachment);
  if (mime === 'text/markdown' || MARKDOWN_EXTENSIONS.has(ext)) return 'MD';
  if (mime === 'text/plain' || TEXT_EXTENSIONS.has(ext)) return 'TXT';
  if (mime === 'application/json' || ext === 'json') return 'JSON';
  if (mime === 'application/pdf' || ext === 'pdf') return 'PDF';
  if (mime.includes('zip') || mime.includes('gzip') || ARCHIVE_EXTENSIONS.has(ext)) return 'ZIP';
  return 'FILE';
}
