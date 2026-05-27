'use strict';
process.env.NODE_NO_WARNINGS = '1';

const express = require('express');
const path = require('path');
const fs = require('fs');
const sharp = require('sharp');
const { parseXml } = require('./parseXml');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const { DatabaseSync } = require('node:sqlite');
const THUMB_DIR = path.join(__dirname, 'thumbnails');
if (!fs.existsSync(THUMB_DIR)) fs.mkdirSync(THUMB_DIR, { recursive: true });

// ── SQLite settings ───────────────────────────────────────────────────────────
let _db;
function getDb() {
  if (!_db) {
    _db = new DatabaseSync(path.join(__dirname, 'viewer.db'));
    _db.exec(`
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
    `);
  }
  return _db;
}
function getSetting(key) {
  const row = getDb().prepare('SELECT value FROM settings WHERE key=?').get(key);
  return row ? row.value : null;
}
function setSetting(key, value) {
  getDb().prepare('INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)').run(key, value);
}

// ── Image/XML extensions ──────────────────────────────────────────────────────
const IMG_EXTS = new Set(['.jpg', '.jpeg', '.png', '.tif', '.tiff', '.webp', '.bmp', '.avif']);
const XML_EXTS = new Set(['.xml']);

// ── Document discovery ────────────────────────────────────────────────────────
// A "document" is an XML file that has a corresponding image with the same basename.
// We scan inputDir for XML files and look for a sidecar image.

let docCache = null;
let docCacheDir = null;

function findSidecarImage(dir, basename) {
  for (const ext of IMG_EXTS) {
    const candidate = path.join(dir, basename + ext);
    if (fs.existsSync(candidate)) return basename + ext;
  }
  // Also check a common pattern: images in a sibling "images" or "img" folder
  for (const sub of ['images', 'img', 'image', 'jpg', 'tiff', 'tif']) {
    const subDir = path.join(dir, sub);
    if (fs.existsSync(subDir)) {
      for (const ext of IMG_EXTS) {
        const candidate = path.join(subDir, basename + ext);
        if (fs.existsSync(candidate)) return path.join(sub, basename + ext);
      }
    }
  }
  return null;
}

function getDocuments(inputDir) {
  if (docCache && docCacheDir === inputDir) return docCache;
  if (!inputDir || !fs.existsSync(inputDir)) return [];

  const files = fs.readdirSync(inputDir);
  const docs = [];

  for (const f of files) {
    const ext = path.extname(f).toLowerCase();
    if (!XML_EXTS.has(ext)) continue;
    const basename = path.basename(f, ext);
    const imgRel = findSidecarImage(inputDir, basename);
    docs.push({
      id: basename,
      xmlFile: f,
      imgFile: imgRel,   // may be null if no image found
      hasImage: !!imgRel,
    });
  }

  docs.sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true, sensitivity: 'base' }));
  docCache = docs;
  docCacheDir = inputDir;
  return docs;
}

function invalidateCache() { docCache = null; docCacheDir = null; }

// ── Settings ──────────────────────────────────────────────────────────────────
app.get('/api/settings', (req, res) => {
  res.json({ inputDir: getSetting('inputDir') || '' });
});

app.post('/api/settings', (req, res) => {
  const { inputDir } = req.body;
  if (inputDir !== undefined) { setSetting('inputDir', inputDir); invalidateCache(); }
  res.json({ ok: true });
});

app.post('/api/settings/validate', (req, res) => {
  const { dir } = req.body;
  if (!dir) return res.json({ valid: false, error: 'Empty path' });
  const exists = fs.existsSync(dir);
  const isDir = exists && fs.statSync(dir).isDirectory();
  res.json({ valid: isDir, error: isDir ? null : exists ? 'Not a directory' : 'Does not exist' });
});

// ── Documents list ────────────────────────────────────────────────────────────
app.get('/api/docs', (req, res) => {
  const inputDir = getSetting('inputDir');
  if (!inputDir) return res.json({ docs: [], total: 0 });
  const page = Math.max(0, parseInt(req.query.page) || 0);
  const limit = Math.min(200, Math.max(10, parseInt(req.query.limit) || 50));
  const search = (req.query.search || '').toLowerCase();

  let docs = getDocuments(inputDir);
  if (search) docs = docs.filter(d => d.id.toLowerCase().includes(search));

  const total = docs.length;
  const slice = docs.slice(page * limit, (page + 1) * limit);
  res.json({ docs: slice, total, page, pages: Math.ceil(total / limit) });
});

// ── Thumbnail ─────────────────────────────────────────────────────────────────
app.get('/api/thumb/:docid', async (req, res) => {
  const inputDir = getSetting('inputDir');
  if (!inputDir) return res.status(404).send('No input dir');

  const docs = getDocuments(inputDir);
  const doc = docs.find(d => d.id === req.params.docid);
  if (!doc || !doc.hasImage) return res.status(404).send('No image');

  const imgPath = path.join(inputDir, doc.imgFile);
  const thumbName = req.params.docid.replace(/[^a-zA-Z0-9._-]/g, '_') + '.webp';
  const thumbPath = path.join(THUMB_DIR, thumbName);

  try {
    if (!fs.existsSync(thumbPath)) {
      await sharp(imgPath)
        .resize(180, 260, { fit: 'inside', withoutEnlargement: true })
        .webp({ quality: 75 })
        .toFile(thumbPath);
    }
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.setHeader('Content-Type', 'image/webp');
    fs.createReadStream(thumbPath).pipe(res);
  } catch {
    res.status(415).send('Cannot process');
  }
});

// ── Full image ────────────────────────────────────────────────────────────────
app.get('/api/image/:docid', async (req, res) => {
  const inputDir = getSetting('inputDir');
  if (!inputDir) return res.status(404).send('No input dir');

  const docs = getDocuments(inputDir);
  const doc = docs.find(d => d.id === req.params.docid);
  if (!doc || !doc.hasImage) return res.status(404).send('No image');

  const imgPath = path.join(inputDir, doc.imgFile);
  const ext = path.extname(doc.imgFile).toLowerCase();

  try {
    if (['.jpg', '.jpeg', '.png', '.webp'].includes(ext)) {
      res.setHeader('Cache-Control', 'public, max-age=3600');
      return fs.createReadStream(imgPath).pipe(res);
    }
    const buf = await sharp(imgPath).jpeg({ quality: 92 }).toBuffer();
    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.send(buf);
  } catch (e) {
    res.status(500).send('Image error: ' + e.message);
  }
});

// ── XML parse & serve ─────────────────────────────────────────────────────────
const xmlCache = new Map(); // docid → parsed data (in-memory LRU-ish, max 30)

app.get('/api/xml/:docid', async (req, res) => {
  const inputDir = getSetting('inputDir');
  if (!inputDir) return res.status(404).json({ error: 'No input dir' });

  const docs = getDocuments(inputDir);
  const doc = docs.find(d => d.id === req.params.docid);
  if (!doc) return res.status(404).json({ error: 'Document not found' });

  if (xmlCache.has(doc.id)) return res.json(xmlCache.get(doc.id));

  const xmlPath = path.join(inputDir, doc.xmlFile);
  const imgPath = doc.hasImage ? path.join(inputDir, doc.imgFile) : null;

  try {
    const data = await parseXml(xmlPath, imgPath);
    if (xmlCache.size > 30) xmlCache.delete(xmlCache.keys().next().value);
    xmlCache.set(doc.id, data);
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Stats ─────────────────────────────────────────────────────────────────────
app.get('/api/stats', (req, res) => {
  const inputDir = getSetting('inputDir');
  const docs = getDocuments(inputDir);
  res.json({
    total: docs.length,
    withImage: docs.filter(d => d.hasImage).length,
  });
});

const PORT = process.env.PORT || 3838;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n📜  XML Viewer running at http://localhost:${PORT}\n`);
});
