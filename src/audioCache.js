import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';

function sanitizeSlug(input) {
  return (
    String(input || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 32) || 'audio'
  );
}

export function buildCacheKey({ text, speed, kind }) {
  const normalizedText = String(text || '').trim().toLocaleLowerCase('pt-BR');
  const normalizedSpeed = speed === 'slow' ? 'slow' : 'normal';
  const normalizedKind =
    kind === 'sentence' ? 'sentence' : kind === 'word' ? 'word' : 'block';

  const signature = JSON.stringify({
    t: normalizedText,
    s: normalizedSpeed,
    k: normalizedKind,
    m: config.ttsModel,
    v: config.ttsVoice,
  });

  const hash = crypto.createHash('sha256').update(signature).digest('hex').slice(0, 16);
  const slug = sanitizeSlug(normalizedText);
  return `${normalizedKind}_${normalizedSpeed}_${slug}_${hash}.mp3`;
}

export function getCacheFilePath(fileName) {
  return path.join(config.paths.audioCacheDir, fileName);
}

export async function ensureCacheDir() {
  await fsp.mkdir(config.paths.audioCacheDir, { recursive: true });
}

export async function hasCachedAudio(fileName) {
  try {
    const stat = await fsp.stat(getCacheFilePath(fileName));
    return stat.isFile() && stat.size > 0;
  } catch {
    return false;
  }
}

export async function saveAudioToCache(fileName, audioBuffer) {
  await ensureCacheDir();
  const targetPath = getCacheFilePath(fileName);
  const tempPath = `${targetPath}.${process.pid}.${Date.now()}.tmp`;
  await fsp.writeFile(tempPath, audioBuffer);
  await fsp.rename(tempPath, targetPath);
  return targetPath;
}

export async function countCachedFiles() {
  try {
    const files = await fsp.readdir(config.paths.audioCacheDir);
    return files.filter((f) => f.endsWith('.mp3')).length;
  } catch {
    return 0;
  }
}

/**
 * Serve um arquivo MP3 do cache com suporte a HTTP Range (essencial para iOS Safari / mobile).
 */
export async function streamCachedAudio(req, res, fileName, { cacheHit }) {
  const filePath = getCacheFilePath(fileName);
  const stat = await fsp.stat(filePath);
  const total = stat.size;
  const range = req.headers.range;

  const baseHeaders = {
    'Content-Type': 'audio/mpeg',
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'public, max-age=31536000, immutable',
    'X-Audio-Cache': cacheHit ? 'HIT' : 'MISS',
  };

  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    if (!match) {
      res.writeHead(416, { 'Content-Range': `bytes */${total}` });
      res.end();
      return;
    }

    const start = match[1] ? Number.parseInt(match[1], 10) : 0;
    const end = match[2] ? Number.parseInt(match[2], 10) : total - 1;

    if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= total) {
      res.writeHead(416, { 'Content-Range': `bytes */${total}` });
      res.end();
      return;
    }

    const safeEnd = Math.min(end, total - 1);
    const chunkSize = safeEnd - start + 1;

    res.writeHead(206, {
      ...baseHeaders,
      'Content-Range': `bytes ${start}-${safeEnd}/${total}`,
      'Content-Length': chunkSize,
    });

    if (req.method === 'HEAD') {
      res.end();
      return;
    }

    fs.createReadStream(filePath, { start, end: safeEnd }).pipe(res);
    return;
  }

  res.writeHead(200, {
    ...baseHeaders,
    'Content-Length': total,
  });

  if (req.method === 'HEAD') {
    res.end();
    return;
  }

  fs.createReadStream(filePath).pipe(res);
}
