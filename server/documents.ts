// File validation, text extraction and chunking. Pure except for the PDF parser.
import { isUtf8 } from 'node:buffer';
import { ApplicationFailure } from '@temporalio/common';
import { extractText, getDocumentProxy } from 'unpdf';

export const MAX_UPLOAD_BYTES = Number(process.env.MAX_UPLOAD_MB ?? 15) * 1024 * 1024;
export const UPLOAD_TYPES = ['application/pdf', 'image/png', 'image/jpeg', 'text/plain'] as const;

/** Type from the bytes themselves; the client's Content-Type is only a hint. */
export function sniffMime(bytes: Buffer): (typeof UPLOAD_TYPES)[number] | undefined {
  if (bytes.subarray(0, 1024).includes('%PDF-')) return 'application/pdf';
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length > 0 && !bytes.includes(0) && isUtf8(bytes)) return 'text/plain';
  return undefined;
}

export function safeFilename(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? '';
  // Control and markup characters out; the name is shown in the UI and sent in headers.
  const clean = base.replace(/[\u0000-\u001f\u007f<>:"|?*]+/g, '_').trim().slice(0, 200);
  return clean || 'document';
}

export async function extractPdfPages(bytes: Buffer): Promise<string[]> {
  try {
    const pdf = await getDocumentProxy(new Uint8Array(bytes));
    return (await extractText(pdf, { mergePages: false })).text;
  } catch (err) {
    const name = err instanceof Error ? err.name : 'Error';
    const reason = name === 'PasswordException' ? 'the PDF is password-protected' : `the PDF could not be parsed (${name})`;
    throw ApplicationFailure.nonRetryable(reason, 'InvalidDocument');
  }
}

/** A text layer this thin means a scanned PDF: the words are pixels. */
export function needsOcr(pages: string[]): boolean {
  const chars = pages.join('').replace(/\s+/g, '').length;
  return chars < Math.max(30, pages.length * 20);
}

export interface Chunk { index: number; page: number; content: string }

/**
 * Splits each page into ~`max`-char chunks with overlap, preferring paragraph,
 * sentence and word boundaries. Chunks never span pages, so every chunk cites one page.
 */
export function chunkPages(pages: string[], max = 1000, overlap = 150): Chunk[] {
  const chunks: Chunk[] = [];
  pages.forEach((raw, i) => {
    const text = raw.replace(/[ \t]+/g, ' ').replace(/\n\s*\n\s*\n+/g, '\n\n').trim();
    let start = 0;
    while (start < text.length) {
      let end = Math.min(text.length, start + max);
      if (end < text.length) {
        const floor = start + Math.floor(max * 0.6);
        const window = text.slice(floor, end);
        const cut = Math.max(window.lastIndexOf('\n'), window.lastIndexOf('. '), window.lastIndexOf(' '));
        if (cut > 0) end = floor + cut + 1;
      }
      const content = text.slice(start, end).trim();
      if (content) chunks.push({ index: chunks.length, page: i + 1, content });
      if (end >= text.length) break;
      start = Math.max(end - overlap, start + 1);
    }
  });
  return chunks;
}

/** Case, punctuation and whitespace-insensitive form, for checking model quotes against source text. */
export const normalize = (s: string) =>
  s.toLowerCase().normalize('NFKC').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/** True when `quote` really occurs in `text`. Quotes too short to mean anything don't count. */
export function quoteIn(quote: string, text: string): boolean {
  const q = normalize(quote);
  if (q.length < 6) return false;
  return normalize(text).includes(q);
}

/** 1-based page where the excerpt occurs (whole, or its first 12 words), or null. */
export function locatePage(excerpt: string, pages: string[]): number | null {
  const words = normalize(excerpt).split(' ');
  const candidates = [words.join(' '), words.slice(0, 12).join(' ')].filter((c) => c.length >= 12);
  for (const c of candidates) {
    const i = pages.findIndex((p) => normalize(p).includes(c));
    if (i >= 0) return i + 1;
  }
  return null;
}
