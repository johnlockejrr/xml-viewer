'use strict';

const { XMLParser } = require('fast-xml-parser');
const fs = require('fs');
const path = require('path');

// ── XML parser config ─────────────────────────────────────────────────────────
const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  removeNSPrefix: true,           // strips namespace prefixes → local names only
  isArray: (name) => [
    'Page', 'TextRegion', 'ImageRegion', 'TableRegion', 'SeparatorRegion',
    'GraphicRegion', 'ChartRegion', 'MathsRegion', 'NoiseRegion', 'UnknownRegion',
    'TextLine', 'TextBlock', 'ComposedBlock', 'String', 'SP', 'HYP',
    'Tag', 'OtherTag', 'LayoutTag', 'StructureTag', 'ParagraphTag', 'ContentTag',
  ].includes(name),
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function localName(tag) {
  // fast-xml-parser with removeNSPrefix already strips ns, but just in case
  return tag.includes(':') ? tag.split(':').pop() : tag;
}

function detectFormat(root) {
  const keys = Object.keys(root);
  for (const k of keys) {
    const ln = localName(k);
    if (ln === 'PcGts' || ln === 'pcGts') return 'PAGE';
    if (ln === 'alto' || ln === 'ALTO') return 'ALTO';
  }
  // fallback: look for xmlns attributes
  const rootEl = root[keys[0]];
  if (rootEl) {
    const attrs = Object.entries(rootEl).filter(([k]) => k.startsWith('@_'));
    for (const [, v] of attrs) {
      if (typeof v === 'string') {
        if (v.includes('PAGE') || v.includes('page-xml')) return 'PAGE';
        if (v.includes('alto')) return 'ALTO';
      }
    }
  }
  return null;
}

function parsePoints(pointsStr, imgW, imgH) {
  if (!pointsStr) return [];
  const parts = pointsStr.trim().split(/[\s,]+/);
  const pts = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const x = parseFloat(parts[i]);
    const y = parseFloat(parts[i + 1]);
    if (!isNaN(x) && !isNaN(y)) {
      pts.push({ x: x / imgW, y: y / imgH });
    }
  }
  return pts;
}

function bboxToPolygon(hpos, vpos, w, h, imgW, imgH) {
  const x0 = hpos / imgW, y0 = vpos / imgH;
  const x1 = (hpos + w) / imgW, y1 = (vpos + h) / imgH;
  return [
    { x: x0, y: y0 }, { x: x1, y: y0 },
    { x: x1, y: y1 }, { x: x0, y: y1 },
  ];
}

function stripTypePrefix(custom) {
  if (!custom) return null;
  const s = custom.trim();
  const m = s.match(/^type:\s*([^;]+)\s*;?/i);
  if (m) {
    const rest = s.slice(m[0].length).trim().replace(/^;/, '').trim();
    return rest || m[1].trim();
  }
  return s || null;
}

function pageLabel(el) {
  const custom = el['@_custom'];
  if (custom) return stripTypePrefix(custom);
  return el['@_id'] || null;
}

function coordsPoints(el, imgW, imgH) {
  const coords = el.Coords;
  if (!coords) return [];
  const pts = (coords['@_points'] || '');
  return parsePoints(pts, imgW, imgH);
}

function baselineFromLine(lineEl, imgW, imgH) {
  const bl = lineEl.Baseline;
  if (!bl) return null;
  const raw = bl['@_points'];
  if (!raw) return null;
  const pts = parsePoints(raw, imgW, imgH);
  if (pts.length < 2) return null;
  return { id: lineEl['@_id'] || 'baseline', points: pts };
}

function bboxFromTextlines(textlines) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const tl of textlines) {
    for (const p of tl.coords) {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
  }
  if (!isFinite(minX)) return [];
  return [
    { x: minX, y: minY }, { x: maxX, y: minY },
    { x: maxX, y: maxY }, { x: minX, y: maxY },
  ];
}

// ── Text extraction from PAGE TextLine ───────────────────────────────────────
function extractPageText(lineEl) {
  // TextEquiv/Unicode is the transcription
  const te = lineEl.TextEquiv;
  if (te) {
    const unicode = Array.isArray(te) ? te[0]?.Unicode : te?.Unicode;
    if (unicode && typeof unicode === 'string' && unicode.trim()) return unicode.trim();
    if (unicode && typeof unicode === 'object') {
      const v = unicode['#text'] || unicode['_text'] || '';
      if (v.trim()) return v.trim();
    }
  }
  // Fallback: collect Word/TextEquiv
  const words = lineEl.Word;
  if (words && Array.isArray(words)) {
    const parts = words.map(w => {
      const wte = w.TextEquiv;
      if (!wte) return '';
      const u = Array.isArray(wte) ? wte[0]?.Unicode : wte?.Unicode;
      return (typeof u === 'string' ? u : u?.['#text'] || '').trim();
    }).filter(Boolean);
    if (parts.length) return parts.join(' ');
  }
  return null;
}

// ── PAGE-XML parser ───────────────────────────────────────────────────────────

const PAGE_REGION_TYPES = [
  'TextRegion', 'ImageRegion', 'TableRegion', 'SeparatorRegion',
  'GraphicRegion', 'ChartRegion', 'MathsRegion', 'NoiseRegion', 'UnknownRegion',
];

function parsePage(parsed, imgW, imgH) {
  // Navigate to Page element
  const rootKey = Object.keys(parsed).find(k => !k.startsWith('?') && !k.startsWith('@'));
  const rootEl = parsed[rootKey];

  // Find Page element (could be nested under PcGts > Page or directly)
  let pageEl = rootEl?.Page?.[0] || rootEl?.Page || null;
  if (!pageEl) {
    // Try one level deeper
    for (const key of Object.keys(rootEl || {})) {
      if (localName(key) === 'Page') { pageEl = rootEl[key]; break; }
    }
  }
  if (!pageEl) throw new Error('No Page element found in PAGE-XML');
  if (Array.isArray(pageEl)) pageEl = pageEl[0];

  const regions = [];

  for (const rtype of PAGE_REGION_TYPES) {
    const regionEls = pageEl[rtype];
    if (!regionEls) continue;
    const arr = Array.isArray(regionEls) ? regionEls : [regionEls];
    for (const el of arr) {
      const rid = el['@_id'] || rtype;
      const label = pageLabel(el);
      // Detect subtype from @type attribute (TextRegion can have type="paragraph" etc.)
      const subtype = el['@_type'] || null;
      const coords = coordsPoints(el, imgW, imgH);
      const textlines = [];

      if (rtype === 'TextRegion') {
        const lines = el.TextLine;
        if (lines) {
          const lineArr = Array.isArray(lines) ? lines : [lines];
          for (const lineEl of lineArr) {
            const tid = lineEl['@_id'] || 'line';
            const tlabel = pageLabel(lineEl);
            const tcoords = coordsPoints(lineEl, imgW, imgH);
            if (!tcoords.length) continue;
            const bl = baselineFromLine(lineEl, imgW, imgH);
            const text = extractPageText(lineEl);
            textlines.push({ id: tid, label: tlabel, coords: tcoords, baseline: bl, text });
          }
        }
      }

      const finalCoords = coords.length ? coords : bboxFromTextlines(textlines);
      if (!finalCoords.length) continue;

      regions.push({ id: rid, type: rtype, subtype, label, coords: finalCoords, textlines });
    }
  }

  return { format: 'PAGE', imageWidth: imgW, imageHeight: imgH, regions };
}

// ── ALTO-XML parser ───────────────────────────────────────────────────────────

function altoTagMap(parsed) {
  const map = {};
  const tagSectionTypes = ['Tag','OtherTag','LayoutTag','StructureTag','ParagraphTag','ContentTag'];
  function walk(obj) {
    if (!obj || typeof obj !== 'object') return;
    for (const [key, val] of Object.entries(obj)) {
      const ln = localName(key);
      if (tagSectionTypes.includes(ln)) {
        const arr = Array.isArray(val) ? val : [val];
        for (const el of arr) {
          const id = el['@_ID'] || el['@_id'];
          const label = (el['@_LABEL'] || el['@_label'] || el['@_TYPE'] || el['@_type'] || '').trim();
          if (id && label) map[id] = label;
        }
      } else if (typeof val === 'object') {
        walk(val);
      }
    }
  }
  walk(parsed);
  return map;
}

function altoStringsText(lineEl) {
  const strings = lineEl.String;
  if (!strings) return null;
  const arr = Array.isArray(strings) ? strings : [strings];
  const parts = arr.map(s => (s['@_CONTENT'] || s['@_content'] || '')).filter(Boolean);
  return parts.length ? parts.join(' ') : null;
}

function altoLineLabel(lineEl, tagMap) {
  const refs = lineEl['@_TAGREFS'] || lineEl['@_tagrefs'];
  if (refs) {
    const parts = refs.split(/\s+/).map(r => tagMap[r]).filter(Boolean);
    if (parts.length) return parts.join(' ');
  }
  return altoStringsText(lineEl) || lineEl['@_ID'] || null;
}

function altoBlockLabel(blockEl, tagMap) {
  const refs = blockEl['@_TAGREFS'] || blockEl['@_tagrefs'];
  if (refs) {
    const parts = refs.split(/\s+/).map(r => tagMap[r]).filter(Boolean);
    if (parts.length) return parts.join(' ');
  }
  return blockEl['@_ID'] || null;
}

function altoBaseline(lineEl, pageW, pageH) {
  const raw = lineEl['@_BASELINE'];
  if (!raw) return null;
  const parts = raw.replace(/,/g, ' ').trim().split(/\s+/);
  if (parts.length < 4 || parts.length % 2 !== 0) return null;
  const pts = [];
  for (let i = 0; i < parts.length; i += 2) {
    const x = parseFloat(parts[i]) / pageW;
    const y = parseFloat(parts[i + 1]) / pageH;
    if (isNaN(x) || isNaN(y)) return null;
    pts.push({ x, y });
  }
  if (pts.length < 2) return null;
  return { id: lineEl['@_ID'] || 'baseline', points: pts };
}

// Extract Shape/Polygon POINTS if present, else fall back to bbox attributes
function altoShapeOrBbox(el, imgW, imgH) {
  const shape = el.Shape;
  if (shape) {
    const poly = shape.Polygon || shape.polygon;
    if (poly) {
      const pts = poly['@_POINTS'] || poly['@_points'] || '';
      if (pts && typeof pts === 'string' && pts.trim()) {
        return parsePoints(pts, imgW, imgH);
      }
    }
  }
  // Fallback: bbox attributes
  const hpos = parseFloat(el['@_HPOS'] || 0);
  const vpos = parseFloat(el['@_VPOS'] || 0);
  const w    = parseFloat(el['@_WIDTH']  || 0);
  const h    = parseFloat(el['@_HEIGHT'] || 0);
  if (w <= 0 || h <= 0) return [];
  return bboxToPolygon(hpos, vpos, w, h, imgW, imgH);
}

function parseAlto(parsed, pageW, pageH) {
  const tagMap = altoTagMap(parsed);
  const rootKey = Object.keys(parsed).find(k => !k.startsWith('?') && !k.startsWith('@'));
  const rootEl = parsed[rootKey];

  const layout = rootEl?.Layout;
  if (!layout) throw new Error('No Layout element in ALTO-XML');
  const pageEl = Array.isArray(layout.Page) ? layout.Page[0] : layout.Page;
  if (!pageEl) throw new Error('No Layout/Page in ALTO-XML');

  const regions = [];

  function processBlock(block) {
    const coords = altoShapeOrBbox(block, pageW, pageH);
    if (!coords.length) return;

    const label = altoBlockLabel(block, tagMap);
    const textlines = [];

    const lineEls = block.TextLine;
    if (lineEls) {
      const arr = Array.isArray(lineEls) ? lineEls : [lineEls];
      for (const lineEl of arr) {
        const tcoords = altoShapeOrBbox(lineEl, pageW, pageH);
        if (!tcoords.length) continue;
        const tlabel = altoLineLabel(lineEl, tagMap);
        const bl = altoBaseline(lineEl, pageW, pageH);
        const text = altoStringsText(lineEl);
        textlines.push({
          id: lineEl['@_ID'] || 'line',
          label: tlabel,
          coords: tcoords,
          baseline: bl,
          text,
        });
      }
    }

    regions.push({
      id: block['@_ID'] || 'block',
      type: 'TextBlock',
      subtype: null,
      label,
      coords,
      textlines,
    });
  }

  function collectBlocks(el) {
    if (!el || typeof el !== 'object') return;
    const blocks = el.TextBlock;
    if (blocks) {
      const arr = Array.isArray(blocks) ? blocks : [blocks];
      for (const block of arr) processBlock(block);
    }
    const composed = el.ComposedBlock;
    if (composed) {
      const arr = Array.isArray(composed) ? composed : [composed];
      for (const cb of arr) collectBlocks(cb);
    }
  }

  const ps = pageEl.PrintSpace;
  if (ps) collectBlocks(ps);
  collectBlocks(pageEl);

  return { format: 'ALTO', imageWidth: pageW, imageHeight: pageH, regions };
}

// ── Image dimensions via sharp ────────────────────────────────────────────────
async function getImageDimensions(imgPath) {
  try {
    const sharp = require('sharp');
    const meta = await sharp(imgPath).metadata();
    return { w: meta.width || 0, h: meta.height || 0 };
  } catch {
    return { w: 0, h: 0 };
  }
}

// ── Main entry ────────────────────────────────────────────────────────────────
async function parseXml(xmlPath, imgPath) {
  const content = fs.readFileSync(xmlPath, 'utf8');
  const parsed = parser.parse(content);

  const fmt = detectFormat(parsed);
  if (!fmt) throw new Error('Unknown XML format (not PAGE or ALTO)');

  // Try to get dimensions from XML first
  let imgW = 0, imgH = 0;
  const rootKey = Object.keys(parsed).find(k => !k.startsWith('?') && !k.startsWith('@'));
  const rootEl = parsed[rootKey];

  if (fmt === 'PAGE') {
    const pageArr = rootEl?.Page;
    const pageEl = Array.isArray(pageArr) ? pageArr[0] : pageArr;
    imgW = parseInt(pageEl?.['@_imageWidth'] || 0);
    imgH = parseInt(pageEl?.['@_imageHeight'] || 0);
  } else {
    const layout = rootEl?.Layout;
    const pageEl = Array.isArray(layout?.Page) ? layout.Page[0] : layout?.Page;
    imgW = parseInt(parseFloat(pageEl?.['@_WIDTH'] || 0));
    imgH = parseInt(parseFloat(pageEl?.['@_HEIGHT'] || 0));
  }

  // Fallback to actual image dimensions
  if ((imgW <= 0 || imgH <= 0) && imgPath) {
    const dims = await getImageDimensions(imgPath);
    imgW = dims.w;
    imgH = dims.h;
  }

  if (imgW <= 0 || imgH <= 0) throw new Error('Could not determine image dimensions');

  const result = fmt === 'PAGE'
    ? parsePage(parsed, imgW, imgH)
    : parseAlto(parsed, imgW, imgH);

  // Collect all distinct region types and line types actually present
  const regionTypes = [...new Set(result.regions.map(r => r.type))];
  const lineTypes = [...new Set(
    result.regions.flatMap(r => r.textlines.map(l => l.label)).filter(Boolean)
  )];

  return { ...result, regionTypes, lineTypes };
}

module.exports = { parseXml };
