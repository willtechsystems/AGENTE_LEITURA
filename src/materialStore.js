import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import mammoth from 'mammoth';
import { config } from './config.js';
import { normalizeWordKey } from './syllableCache.js';

const require = createRequire(import.meta.url);
// Import direto de lib/pdf-parse.js evita o comportamento de debug do index.js do pdf-parse@1.1.1
const pdfParse = require('pdf-parse/lib/pdf-parse.js');

export async function loadMaterials() {
  try {
    const raw = await fs.readFile(config.paths.materialsFile, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function saveMaterials(materials) {
  await fs.mkdir(path.dirname(config.paths.materialsFile), { recursive: true });
  const tempFile = `${config.paths.materialsFile}.tmp`;
  await fs.writeFile(tempFile, JSON.stringify(materials, null, 2) + '\n', 'utf8');
  await fs.rename(tempFile, config.paths.materialsFile);
}

/**
 * Extrai texto limpo de .txt, .pdf ou .docx a partir de um Buffer.
 */
export async function extractTextFromFile({ fileName = '', buffer }) {
  const ext = path.extname(fileName).toLowerCase();

  if (ext === '.pdf') {
    const parsed = await pdfParse(buffer);
    return {
      sourceType: 'pdf',
      text: String(parsed?.text || ''),
    };
  }

  if (ext === '.docx') {
    const parsed = await mammoth.extractRawText({ buffer });
    return {
      sourceType: 'docx',
      text: String(parsed?.value || ''),
    };
  }

  if (ext === '.txt' || ext === '.md' || !ext) {
    return {
      sourceType: 'txt',
      text: buffer.toString('utf8'),
    };
  }

  throw new Error(
    `Formato "${ext}" não suportado. Envie arquivos .pdf, .docx ou .txt (ou cole o texto).`
  );
}

/**
 * Limpa quebras artificiais e divide o texto em trechos curtos e confortáveis para ler no celular.
 */
export function splitIntoReadingChunks(rawText, maxWordsPerChunk = 18) {
  const cleaned = String(rawText || '')
    .replace(/\r\n/g, '\n')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  if (!cleaned) return [];

  const paragraphs = cleaned
    .split(/\n+/)
    .map((p) => p.trim())
    .filter(Boolean);

  const chunks = [];

  for (const paragraph of paragraphs) {
    // Divide por final de frase mantendo a pontuação
    const sentences = paragraph
      .split(/(?<=[.!?…])\s+/)
      .map((s) => s.trim())
      .filter(Boolean);

    for (const sentence of sentences) {
      const words = sentence.split(/\s+/);
      if (words.length <= maxWordsPerChunk) {
        chunks.push(sentence);
      } else {
        // Quebra frases muito longas em blocos menores (preferindo vírgulas ou ponto-e-vírgula)
        let current = [];
        for (const word of words) {
          current.push(word);
          const endsWithPause = /[,;:—–]$/.test(word);
          if (
            current.length >= maxWordsPerChunk ||
            (endsWithPause && current.length >= Math.floor(maxWordsPerChunk * 0.65))
          ) {
            chunks.push(current.join(' '));
            current = [];
          }
        }
        if (current.length > 0) {
          chunks.push(current.join(' '));
        }
      }
    }
  }

  return chunks.slice(0, 120); // Limite seguro para o MVP
}

/**
 * Extrai palavras únicas (com letras pt-BR) de um trecho para análise silábica.
 */
export function extractUniqueWordsFromText(text) {
  const matches = String(text || '').match(/[A-Za-zÀ-ÖØ-öø-ÿ]+/g) || [];
  const seen = new Set();
  const result = [];
  for (const m of matches) {
    const key = normalizeWordKey(m);
    if (key.length >= 2 && !seen.has(key)) {
      seen.add(key);
      result.push(key);
    }
  }
  return result;
}

export async function createMaterial({ title, rawText, sourceType = 'texto' }) {
  const chunkStrings = splitIntoReadingChunks(rawText);
  if (chunkStrings.length === 0) {
    throw new Error('Não foi possível extrair texto legível deste conteúdo.');
  }

  const materials = await loadMaterials();
  const safeTitle =
    String(title || '').trim().slice(0, 80) ||
    `Leitura ${materials.length + 1}`;

  const material = {
    id: `mat-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`,
    title: safeTitle,
    sourceType,
    createdAt: new Date().toISOString(),
    currentChunkIndex: 0,
    chunks: chunkStrings.map((text, index) => ({
      index,
      text,
      done: false,
    })),
  };

  materials.unshift(material);
  await saveMaterials(materials);
  return material;
}

export async function markMaterialChunkDone(materialId, chunkIndex, done = true) {
  const materials = await loadMaterials();
  const mat = materials.find((m) => m.id === materialId);
  if (!mat) return null;

  const idx = Number(chunkIndex);
  if (!Number.isInteger(idx) || idx < 0 || idx >= mat.chunks.length) {
    return null;
  }

  const wasDone = Boolean(mat.chunks[idx].done);
  mat.chunks[idx].done = Boolean(done);
  mat.currentChunkIndex = Math.min(idx + (done ? 1 : 0), mat.chunks.length - 1);

  await saveMaterials(materials);
  return { material: mat, newlyCompleted: Boolean(done) && !wasDone };
}

export async function deleteMaterial(materialId) {
  const materials = await loadMaterials();
  const next = materials.filter((m) => m.id !== materialId);
  if (next.length === materials.length) return false;
  await saveMaterials(next);
  return true;
}
