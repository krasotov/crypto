function sanitizeFileName(name) {
  return String(name || 'document')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * «Иванов Иван Иванович» → «Иванов И.И.»
 */
export function formatSignerInitials(subjectName = '') {
  const name = sanitizeFileName(subjectName);
  if (!name) return 'Подписант';

  const shortMatch = name.match(/^(\S+)\s+((?:[А-ЯA-ZЁ]\.\s*)+)$/i);
  if (shortMatch) {
    return `${shortMatch[1]} ${shortMatch[2].replace(/\s+/g, '')}`;
  }

  const parts = name.split(/\s+/).filter(Boolean);
  if (parts.length === 1) return parts[0];

  const surname = parts[0];
  const initials = parts.slice(1).map((part) => `${part.charAt(0).toUpperCase()}.`).join('');
  return `${surname} ${initials}`;
}

/** document.pdf → document_signed.pdf */
export function buildSignedPdfName(originalFilename = 'document.pdf') {
  const safe = sanitizeFileName(originalFilename);
  const extMatch = safe.match(/(\.[^.]+)$/);
  const ext = extMatch ? extMatch[1] : '.pdf';
  const base = safe.replace(/\.[^.]+$/, '') || 'document';
  return `${base}_signed${ext}`;
}

/** Иванов И.И. document.pdf → Иванов И.И. document.pdf.sig */
export function buildDetachedSigName(originalFilename, certInfo) {
  const safeOriginal = sanitizeFileName(originalFilename || 'document.pdf');
  const signer = formatSignerInitials(certInfo?.subjectName);
  return `${signer} ${safeOriginal}.sig`;
}
