import express from 'express';
import { createReadStream, existsSync, mkdirSync, statSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { config } from '../config.js';
import { getDb } from '../db.js';
import { wrap, HttpError, isoNow } from '../http.js';
import { requireUser } from '../auth/middleware.js';
import { decodeImage } from '../palette.js';

export const router = express.Router();

const DIR = () => join(config.coverDir, '..', 'decorations');
const KINDS = ['frame', 'plant', 'print'];
const MAX_BYTES = 4 * 1024 * 1024;
const MAX_PER_USER = 40;

const toJson = (r) => ({
  id: r.id,
  kind: r.kind,
  caption: r.caption,
  shelfIndex: r.shelf_index,
  position: r.position,
  widthMm: r.width_mm,
  heightMm: r.height_mm,
  hasImage: !!r.image_path,
  imageUrl: `/api/v1/decorations/${r.id}/image`,
});

router.get('/', requireUser, wrap(async (req, res) => {
  const rows = getDb()
    .prepare('SELECT * FROM decorations WHERE user_id = ? ORDER BY shelf_index, position')
    .all(req.user.id);
  res.json(rows.map(toJson));
}));

/**
 * Add something to a shelf. The image arrives as a data URL rather than
 * multipart: it keeps the client simple, needs no upload middleware, and these
 * are small photographs.
 */
router.post('/', requireUser, wrap(async (req, res) => {
  const db = getDb();
  const body = req.body ?? {};

  const count = db.prepare('SELECT COUNT(*) n FROM decorations WHERE user_id = ?').get(req.user.id).n;
  if (count >= MAX_PER_USER) throw new HttpError(400, `you can have up to ${MAX_PER_USER} objects on your shelves`);

  const kind = KINDS.includes(body.kind) ? body.kind : 'frame';
  const caption = String(body.caption ?? '').slice(0, 120);
  const shelfIndex = Math.max(0, Math.min(200, Number(body.shelfIndex) || 0));
  const position = Math.max(0, Math.min(1, Number(body.position ?? 0.5)));

  let imagePath = '';
  let contentType = '';
  let widthMm = Number(body.widthMm) || 120;
  let heightMm = Number(body.heightMm) || 160;

  if (body.image) {
    const m = String(body.image).match(/^data:(image\/(png|jpeg|jpg|webp));base64,(.+)$/);
    if (!m) throw new HttpError(400, 'that image needs to be a PNG, JPEG or WebP');
    const buf = Buffer.from(m[3], 'base64');
    if (buf.length > MAX_BYTES) throw new HttpError(400, 'that image is larger than 4 MB');

    const img = decodeImage(buf, m[1]);
    // WebP is not decodable here, so only validate what we can read; an
    // undecodable PNG or JPEG is a corrupt file and should be refused.
    if (!img && m[2] !== 'webp') throw new HttpError(400, 'that image could not be read');
    if (img) {
      // Keep the real aspect ratio: a squashed photograph looks wrong on a shelf.
      const ratio = img.width / img.height;
      heightMm = 150;
      widthMm = Math.max(60, Math.min(260, Math.round(150 * ratio)));
    }

    mkdirSync(DIR(), { recursive: true });
    const name = `${req.user.id}-${randomBytes(8).toString('hex')}.${m[2] === 'jpg' ? 'jpg' : m[2]}`;
    writeFileSync(join(DIR(), name), buf);
    imagePath = name;
    contentType = m[1];
  }

  const id = db.prepare(`INSERT INTO decorations
      (user_id, kind, caption, image_path, content_type, shelf_index, position, width_mm, height_mm, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(req.user.id, kind, caption, imagePath, contentType, shelfIndex, position, widthMm, heightMm, isoNow())
    .lastInsertRowid;

  res.status(201).json(toJson(db.prepare('SELECT * FROM decorations WHERE id = ?').get(id)));
}));

const ownedOr404 = (userId, id) => {
  const row = getDb().prepare('SELECT * FROM decorations WHERE id = ? AND user_id = ?').get(Number(id), userId);
  if (!row) throw new HttpError(404, 'no such object on your shelves');
  return row;
};

/** Move it, rename it, or resize it. */
router.patch('/:id', requireUser, wrap(async (req, res) => {
  const row = ownedOr404(req.user.id, req.params.id);
  const b = req.body ?? {};
  const sets = [];
  const vals = [];
  if (b.shelfIndex !== undefined) { sets.push('shelf_index = ?'); vals.push(Math.max(0, Math.min(200, Number(b.shelfIndex) || 0))); }
  if (b.position !== undefined) { sets.push('position = ?'); vals.push(Math.max(0, Math.min(1, Number(b.position)))); }
  if (b.caption !== undefined) { sets.push('caption = ?'); vals.push(String(b.caption).slice(0, 120)); }
  if (b.heightMm !== undefined) {
    const h = Math.max(60, Math.min(300, Number(b.heightMm) || 150));
    const ratio = row.width_mm / row.height_mm;
    sets.push('height_mm = ?', 'width_mm = ?');
    vals.push(h, Math.round(h * ratio));
  }
  if (!sets.length) throw new HttpError(400, 'nothing to update');
  vals.push(row.id);
  getDb().prepare(`UPDATE decorations SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  res.json(toJson(getDb().prepare('SELECT * FROM decorations WHERE id = ?').get(row.id)));
}));

router.delete('/:id', requireUser, wrap(async (req, res) => {
  const row = ownedOr404(req.user.id, req.params.id);
  if (row.image_path) {
    try { unlinkSync(join(DIR(), row.image_path)); } catch { /* already gone */ }
  }
  getDb().prepare('DELETE FROM decorations WHERE id = ?').run(row.id);
  res.json({ ok: true });
}));

router.get('/:id/image', requireUser, wrap(async (req, res) => {
  const row = ownedOr404(req.user.id, req.params.id);
  if (!row.image_path) throw new HttpError(404, 'that object has no picture');
  const file = join(DIR(), row.image_path);
  if (!existsSync(file)) throw new HttpError(404, 'that picture is missing');

  const { size, mtimeMs } = statSync(file);
  const etag = `"${row.id}-${size}-${Math.round(mtimeMs)}"`;
  if (req.get('if-none-match') === etag) return res.status(304).end();
  res.setHeader('Content-Type', row.content_type || 'image/jpeg');
  res.setHeader('Content-Length', String(size));
  res.setHeader('ETag', etag);
  res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
  createReadStream(file).pipe(res);
}));
