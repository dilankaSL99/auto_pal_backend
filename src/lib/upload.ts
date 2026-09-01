import { createReadStream, existsSync } from 'node:fs';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import multer from 'multer';
import type { Response } from 'express';
import { ApiError } from './errors';

// All uploads live under <project>/uploads. Physical paths are stored in the DB
// *relative* to this root so the data stays portable if the root moves.
export const UPLOAD_ROOT = path.resolve(process.cwd(), 'uploads');

// Buffer the file in memory (max 10 MB), then we write it to a deterministic
// location keyed by the owning entity so re-uploads overwrite cleanly.
export const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
});

const EXT_MIME: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.heic': 'image/heic',
  '.pdf': 'application/pdf',
};

// Only allow extensions we know how to serve safely (images + PDF). Anything
// else — including active types like .html/.svg/.js — is rejected so an
// attacker can't store content that a browser would execute if it ever reached
// one of the public/inline file endpoints.
const ALLOWED_EXTENSIONS = new Set(Object.keys(EXT_MIME));

function safeExt(originalName: string): string {
  const ext = path.extname(originalName).toLowerCase();
  return ALLOWED_EXTENSIONS.has(ext) ? ext : '';
}

export interface StoredFile {
  relativePath: string; // stored in DB (*Path)
  fileName: string; // original client filename (*FileName)
}

// Persists an uploaded buffer at uploads/<userId>/<category>/<entityId><ext>,
// replacing any previous file for that entity. Returns what to store in the DB.
export async function saveUpload(
  userId: string,
  category: string,
  entityId: string,
  file: Express.Multer.File,
): Promise<StoredFile> {
  const ext = safeExt(file.originalname);
  if (!ext) {
    throw ApiError.badRequest(
      'Unsupported file type. Allowed types: JPG, PNG, WEBP, GIF, HEIC, PDF.',
    );
  }
  const relDir = path.join(userId, category);
  const relativePath = path.join(relDir, `${entityId}${ext}`);
  const absDir = path.join(UPLOAD_ROOT, relDir);
  await mkdir(absDir, { recursive: true });
  await writeFile(path.join(UPLOAD_ROOT, relativePath), file.buffer);
  return { relativePath, fileName: file.originalname };
}

export async function deleteUpload(relativePath: string | null | undefined): Promise<void> {
  if (!relativePath) return;
  const abs = path.join(UPLOAD_ROOT, relativePath);
  // Guard against path traversal escaping the upload root.
  if (!abs.startsWith(UPLOAD_ROOT)) return;
  if (existsSync(abs)) await unlink(abs).catch(() => undefined);
}

// Streams a stored file back to the client with a sensible content type.
export function streamUpload(
  res: Response,
  relativePath: string,
  downloadName?: string | null,
): boolean {
  const abs = path.join(UPLOAD_ROOT, relativePath);
  if (!abs.startsWith(UPLOAD_ROOT) || !existsSync(abs)) return false;
  const mime = EXT_MIME[path.extname(abs).toLowerCase()] ?? 'application/octet-stream';
  res.setHeader('Content-Type', mime);
  if (downloadName) {
    res.setHeader('Content-Disposition', `inline; filename="${downloadName.replace(/"/g, '')}"`);
  }
  createReadStream(abs).pipe(res);
  return true;
}
