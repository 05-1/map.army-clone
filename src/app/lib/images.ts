// Everything drawn as an icon (NATO symbols, uploaded graphics, text, arrowheads) is rasterised to a
// canvas here and registered with MapLibre. Text is drawn locally too, so the app needs no glyph server.
import type { Map as MlMap } from 'maplibre-gl';
import ms from 'milsymbol';
import { sanitizeSvg } from './svg';
import type { Asset } from './types';

const PR = 2; // every generated bitmap is 2x for sharp rendering on HiDPI screens
/** Long side, in CSS px, of an asset bitmap at icon-size 1. */
export const ASSET_BASE = 256;
/** Logical height of the arrowhead bitmap at icon-size 1. */
export const ARROW_BASE = 48;

export type ImageSpec =
  | { id: string; t: 'ms'; sidc: string; size: number; o: Record<string, unknown> }
  | { id: string; t: 'text'; text: string; fontSize: number; color: string; pad: number }
  | { id: string; t: 'asset'; asset: Asset; tint: string | null }
  | { id: string; t: 'ah'; color: string };

// A light casing keeps frames and echelon marks readable on dark and satellite basemaps; text fields
// use the usual map-label treatment (white with a dark halo) for the same reason.
const MS_BASE = {
  outlineWidth: 6, outlineColor: 'rgba(255,255,255,0.9)',
  infoColor: '#ffffff', infoOutlineColor: 'rgba(0,0,0,0.85)', infoOutlineWidth: 8, infoSize: 36,
};

export function symbolDataUrl(sidc: string, size = 26): string {
  return new ms.Symbol(sidc, { size }).toDataURL();
}
export const symbolIsValid = (sidc: string) => !!new ms.Symbol(sidc).isValid();

function canvas(w: number, h: number) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.ceil(w));
  c.height = Math.max(1, Math.ceil(h));
  return c;
}

function drawSymbol(spec: Extract<ImageSpec, { t: 'ms' }>): HTMLCanvasElement {
  const sym = new ms.Symbol(spec.sidc, { ...MS_BASE, size: spec.size, ...spec.o });
  const src = sym.asCanvas(PR);
  const a = sym.getAnchor();
  const s = sym.getSize();
  // Pad so the symbol's anchor (centre of the frame, not of the label-extended box) sits at the bitmap centre.
  const w = 2 * Math.max(a.x, s.width - a.x);
  const h = 2 * Math.max(a.y, s.height - a.y);
  const c = canvas(w * PR, h * PR);
  c.getContext('2d')!.drawImage(src, (w / 2 - a.x) * PR, (h / 2 - a.y) * PR);
  return c;
}

function luminance(hex: string) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return 1;
  const n = parseInt(m[1], 16);
  return (0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
}

function drawText(spec: Extract<ImageSpec, { t: 'text' }>): HTMLCanvasElement {
  const lines = spec.text.split('\n').slice(0, 12);
  const fs = spec.fontSize * PR;
  const font = `600 ${fs}px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;
  const probe = canvas(1, 1).getContext('2d')!;
  probe.font = font;
  const halo = Math.max(2, fs * 0.16);
  const lh = fs * 1.25;
  const w = Math.max(...lines.map((l) => probe.measureText(l).width)) + halo * 2 + 2;
  const h = lines.length * lh + halo * 2;
  const pad = spec.pad * PR;
  const c = canvas(w, h + pad);
  const ctx = c.getContext('2d')!;
  ctx.font = font;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  ctx.lineWidth = halo * 2;
  ctx.strokeStyle = luminance(spec.color) > 0.45 ? 'rgba(0,0,0,0.85)' : 'rgba(255,255,255,0.9)';
  ctx.fillStyle = spec.color;
  lines.forEach((l, i) => {
    const y = pad + halo + lh * (i + 0.5);
    ctx.strokeText(l, c.width / 2, y);
    ctx.fillText(l, c.width / 2, y);
  });
  return c;
}

function drawArrowhead(color: string): HTMLCanvasElement {
  // 32 x 48 logical. The tip sits 8 px above the bitmap centre, so a centre-anchored icon rotated to the
  // line's bearing covers the line's square end and overshoots the true end point by only a few pixels.
  const c = canvas(32 * PR, ARROW_BASE * PR);
  const ctx = c.getContext('2d')!;
  ctx.scale(PR, PR);
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(16, 16);
  ctx.lineTo(32, 48);
  ctx.lineTo(16, 40);
  ctx.lineTo(0, 48);
  ctx.closePath();
  ctx.fill();
  return c;
}

function drawPlaceholder(): HTMLCanvasElement {
  const c = canvas(ASSET_BASE, ASSET_BASE);
  const ctx = c.getContext('2d')!;
  ctx.strokeStyle = '#ff3bd4';
  ctx.lineWidth = 12;
  ctx.strokeRect(6, 6, ASSET_BASE - 12, ASSET_BASE - 12);
  ctx.fillStyle = '#ff3bd4';
  ctx.font = '700 150px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('?', ASSET_BASE / 2, ASSET_BASE / 2 + 8);
  return c;
}

async function loadImage(url: string, mime: string): Promise<HTMLImageElement> {
  let src = url;
  let revoke: string | null = null;
  if (mime === 'image/svg+xml') {
    const text = await (await fetch(url)).text();
    src = revoke = URL.createObjectURL(new Blob([sanitizeSvg(text)], { type: mime }));
  }
  try {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.src = src;
    await img.decode();
    return img;
  } finally {
    if (revoke) URL.revokeObjectURL(revoke);
  }
}

async function drawAsset(url: string, mime: string, tint: string | null): Promise<HTMLCanvasElement> {
  const img = await loadImage(url, mime);
  const iw = img.naturalWidth || ASSET_BASE;
  const ih = img.naturalHeight || ASSET_BASE;
  const k = ASSET_BASE / Math.max(iw, ih);
  const c = canvas(iw * k, ih * k);
  const ctx = c.getContext('2d')!;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, c.width, c.height);
  if (tint) {
    // Flat recolour that keeps the alpha channel: ideal for silhouettes.
    ctx.globalCompositeOperation = 'source-in';
    ctx.fillStyle = tint;
    ctx.fillRect(0, 0, c.width, c.height);
  }
  return c;
}

export class ImageRegistry {
  private pending = new Set<string>();

  constructor(
    private map: MlMap,
    private urlFor: (a: Asset) => string,
    private onAsync: () => void,
  ) {}

  has = (id: string) => this.map.hasImage(id);

  private add(id: string, c: HTMLCanvasElement, pixelRatio: number) {
    if (this.map.hasImage(id)) return;
    const data = c.getContext('2d')!.getImageData(0, 0, c.width, c.height);
    this.map.addImage(id, data, { pixelRatio });
  }

  /** Synchronous for symbols, text and arrowheads. Assets load in the background and call onAsync when ready. */
  ensure(specs: ImageSpec[]) {
    for (const s of specs) {
      if (this.map.hasImage(s.id) || this.pending.has(s.id)) continue;
      if (s.t === 'ms') this.add(s.id, drawSymbol(s), PR);
      else if (s.t === 'text') this.add(s.id, drawText(s), PR);
      else if (s.t === 'ah') this.add(s.id, drawArrowhead(s.color), PR);
      else {
        this.pending.add(s.id);
        drawAsset(this.urlFor(s.asset), s.asset.mime, s.tint)
          .catch(() => drawPlaceholder())
          .then((c) => {
            this.pending.delete(s.id);
            try {
              this.add(s.id, c, 1);
            } catch {
              return; // map was removed while loading
            }
            this.onAsync();
          });
      }
    }
  }
}
