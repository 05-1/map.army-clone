import { sanitizeSvg } from './svg';

export const MAX_UPLOAD_BYTES = 2 * 1024 * 1024;
export const ALLOWED_MIME = ['image/png', 'image/webp', 'image/svg+xml'] as const;
type Mime = (typeof ALLOWED_MIME)[number];

export interface PreparedUpload {
  blob: Blob;
  mime: Mime;
  ext: 'png' | 'webp' | 'svg';
  name: string;
  width: number;
  height: number;
}

const startsWith = (b: Uint8Array, sig: number[], at = 0) => sig.every((v, i) => b[at + i] === v);

/** Decide the type from the file's bytes, never from its name or the browser-reported MIME. */
export function sniffMime(bytes: Uint8Array): Mime | null {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8)) return 'image/webp';
  const head = new TextDecoder().decode(bytes.subarray(0, 2048)).replace(/^﻿/, '').trimStart();
  if (/^(<\?xml[^>]*\?>\s*)?(<!--[\s\S]*?-->\s*)*(<!DOCTYPE[^>]*>\s*)?<svg[\s>]/i.test(head)) return 'image/svg+xml';
  return null;
}

async function dimensions(blob: Blob): Promise<{ width: number; height: number }> {
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return { width: img.naturalWidth || 256, height: img.naturalHeight || 256 };
  } catch {
    throw new Error('The image could not be decoded');
  } finally {
    URL.revokeObjectURL(url);
  }
}

export async function prepareUpload(file: File): Promise<PreparedUpload> {
  if (file.size === 0) throw new Error('File is empty');
  if (file.size > MAX_UPLOAD_BYTES) throw new Error('File is larger than 2 MB');
  const bytes = new Uint8Array(await file.arrayBuffer());
  const mime = sniffMime(bytes);
  if (!mime) throw new Error('Only PNG, WebP and SVG files are supported');

  let blob: Blob = new Blob([bytes], { type: mime });
  if (mime === 'image/svg+xml') {
    blob = new Blob([sanitizeSvg(new TextDecoder().decode(bytes))], { type: mime });
  }
  const { width, height } = await dimensions(blob);
  if (width > 8192 || height > 8192) throw new Error('Image is larger than 8192 px on a side');

  const ext = mime === 'image/png' ? 'png' : mime === 'image/webp' ? 'webp' : 'svg';
  const name = file.name.replace(/\.[^.]+$/, '').slice(0, 80) || 'asset';
  return { blob, mime, ext, name, width, height };
}
