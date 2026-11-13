// Export the map as it is on screen to a PNG or a one-page PDF, with a footer for the title, date
// and the basemap attribution (the imagery providers require it). Runs entirely in the browser:
// the PDF is written by hand (one JPEG page), so there is no PDF library in the bundle.
import type { Map as MlMap } from 'maplibre-gl';

export interface ExportOptions {
  format: 'png' | 'pdf';
  /** 1 = screen resolution, 2 = twice as sharp (takes a moment while the map redraws). */
  scale: 1 | 2;
  title: string;
  subtitle: string;
  /** Plain text. */
  attribution: string;
}

const stripTags = (html: string) => {
  const d = document.createElement('div');
  d.innerHTML = html;
  return (d.textContent ?? '').replace(/\s+/g, ' ').trim();
};
export const attributionText = (html: string) => stripTags(html);

const idle = (map: MlMap, ms: number) => new Promise<void>((ok) => {
  const t = setTimeout(ok, ms);
  map.once('idle', () => (clearTimeout(t), ok()));
});

/** The map's WebGL canvas, read during a frame so the drawing buffer is still there. */
const grab = (map: MlMap) => new Promise<HTMLCanvasElement>((ok) => {
  map.once('render', () => {
    const src = map.getCanvas();
    const c = document.createElement('canvas');
    c.width = src.width;
    c.height = src.height;
    c.getContext('2d')!.drawImage(src, 0, 0);
    ok(c);
  });
  map.triggerRepaint();
});

async function render(map: MlMap, o: ExportOptions): Promise<HTMLCanvasElement> {
  const ratio = map.getPixelRatio();
  let shot: HTMLCanvasElement;
  if (o.scale === 2) {
    map.setPixelRatio(ratio * 2);
    try {
      await idle(map, 15000);
      shot = await grab(map);
    } finally {
      map.setPixelRatio(ratio);
    }
  } else {
    await idle(map, 3000);
    shot = await grab(map);
  }
  const k = shot.width / map.getCanvas().clientWidth;   // device pixels per CSS pixel in the shot
  const foot = Math.round(34 * k);
  const out = document.createElement('canvas');
  out.width = shot.width;
  out.height = shot.height + foot;
  const g = out.getContext('2d')!;
  g.drawImage(shot, 0, 0);
  g.fillStyle = '#14191f';
  g.fillRect(0, shot.height, out.width, foot);
  g.textBaseline = 'middle';
  const y = shot.height + foot / 2;
  g.fillStyle = '#ffffff';
  g.font = `600 ${Math.round(13 * k)}px system-ui, sans-serif`;
  const title = o.title.slice(0, 120);
  g.fillText(title, 10 * k, y);
  const tw = g.measureText(title).width;
  g.fillStyle = '#aab4c0';
  g.font = `${Math.round(11 * k)}px system-ui, sans-serif`;
  g.fillText(o.subtitle, 10 * k + tw + 12 * k, y);
  g.textAlign = 'right';
  g.font = `${Math.round(10 * k)}px system-ui, sans-serif`;
  g.fillText(o.attribution.slice(0, 200), out.width - 10 * k, y);
  return out;
}

/** A single-page PDF around one JPEG, sized to the image (long side = A4 long side). */
export function jpegToPdf(jpeg: Uint8Array, w: number, h: number): Uint8Array {
  const long = 842;
  const W = +(w >= h ? long : (long * w) / h).toFixed(2);
  const H = +(w >= h ? (long * h) / w : long).toFixed(2);
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [];
  const offsets: number[] = [];
  let size = 0;
  const push = (b: Uint8Array | string) => {
    const bytes = typeof b === 'string' ? enc.encode(b) : b;
    parts.push(bytes);
    size += bytes.length;
  };
  const obj = (n: number, body: string) => { offsets[n] = size; push(`${n} 0 obj\n${body}\nendobj\n`); };
  push('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n');
  obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
  obj(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
  obj(3, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>`);
  offsets[4] = size;
  push(`4 0 obj\n<< /Type /XObject /Subtype /Image /Width ${w} /Height ${h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`);
  push(jpeg);
  push('\nendstream\nendobj\n');
  const content = `q ${W} 0 0 ${H} 0 0 cm /Im0 Do Q`;
  obj(5, `<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
  const xref = size;
  push(`xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`);
  push(`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  const out = new Uint8Array(size);
  let at = 0;
  for (const p of parts) (out.set(p, at), (at += p.length));
  return out;
}

function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

const fileName = (title: string, ext: string) => `${(title.replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-') || 'map').slice(0, 60)}-${new Date().toISOString().slice(0, 10)}.${ext}`;

export async function exportMap(map: MlMap, o: ExportOptions): Promise<void> {
  const c = await render(map, o);
  if (o.format === 'png') {
    const blob = await new Promise<Blob>((ok, bad) => c.toBlob((b) => (b ? ok(b) : bad(new Error('Could not create the image'))), 'image/png'));
    return download(blob, fileName(o.title, 'png'));
  }
  const jpeg = await new Promise<Blob>((ok, bad) => c.toBlob((b) => (b ? ok(b) : bad(new Error('Could not create the image'))), 'image/jpeg', 0.92));
  const pdf = jpegToPdf(new Uint8Array(await jpeg.arrayBuffer()), c.width, c.height);
  download(new Blob([pdf as BlobPart], { type: 'application/pdf' }), fileName(o.title, 'pdf'));
}
