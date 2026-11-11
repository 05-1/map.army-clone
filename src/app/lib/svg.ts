import DOMPurify from 'dompurify';

/**
 * Sanitise untrusted SVG markup. Applied twice: before upload and again before every render,
 * so a file that reaches storage by another route is still neutralised.
 */
export function sanitizeSvg(src: string): string {
  const clean = DOMPurify.sanitize(src, {
    USE_PROFILES: { svg: true, svgFilters: true },
    FORBID_TAGS: ['script', 'foreignObject', 'a', 'style'],
    FORBID_ATTR: ['style'],
  });
  const doc = new DOMParser().parseFromString(clean, 'image/svg+xml');
  const svg = doc.documentElement;
  if (!svg || svg.nodeName.toLowerCase() !== 'svg' || doc.querySelector('parsererror')) {
    throw new Error('Not a valid SVG file');
  }
  // External references could be used to track viewers; keep only in-document and embedded ones.
  for (const el of Array.from(svg.querySelectorAll('*'))) {
    for (const attr of ['href', 'xlink:href']) {
      const v = el.getAttribute(attr);
      if (v && !v.startsWith('#') && !v.startsWith('data:image/')) el.removeAttribute(attr);
    }
  }
  // Browsers need explicit dimensions to rasterise an SVG through <img>.
  const vb = svg.getAttribute('viewBox')?.split(/[\s,]+/).map(Number);
  const w = parseFloat(svg.getAttribute('width') ?? '') || vb?.[2] || 256;
  const h = parseFloat(svg.getAttribute('height') ?? '') || vb?.[3] || 256;
  if (!svg.getAttribute('viewBox')) svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
  svg.setAttribute('width', String(w));
  svg.setAttribute('height', String(h));
  svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  return new XMLSerializer().serializeToString(svg);
}
