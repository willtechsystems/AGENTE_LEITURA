import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';
import { loadWords } from './wordStore.js';

const VALID_TYPES = new Set([
  'silaba_simples',
  'digrafo',
  'encontro_consonantal',
  'silaba_complexa',
]);

export function normalizeWordKey(word) {
  return String(word || '')
    .trim()
    .toLocaleLowerCase('pt-BR')
    .normalize('NFC');
}

export async function loadSyllableCache() {
  try {
    const raw = await fs.readFile(config.paths.syllableCacheFile, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

export async function saveSyllableCache(cacheObj) {
  await fs.mkdir(path.dirname(config.paths.syllableCacheFile), { recursive: true });
  const tempFile = `${config.paths.syllableCacheFile}.tmp`;
  await fs.writeFile(tempFile, JSON.stringify(cacheObj, null, 2) + '\n', 'utf8');
  await fs.rename(tempFile, config.paths.syllableCacheFile);
}

/**
 * Monta mapa combinado de palavras já conhecidas (dataset curado + cache de análises anteriores).
 */
export async function getKnownWordBlocksMap() {
  const [datasetWords, cacheObj] = await Promise.all([
    loadWords(),
    loadSyllableCache(),
  ]);

  const map = { ...cacheObj };
  for (const w of datasetWords) {
    const key = normalizeWordKey(w.palavra);
    if (!map[key]) {
      map[key] = {
        palavra: w.palavra,
        dica: w.dica || '',
        blocos: w.blocos,
      };
    }
  }
  return map;
}

export function validateAnalyzedWord(item) {
  if (!item || typeof item !== 'object') return null;
  const palavra = normalizeWordKey(item.palavra);
  if (!palavra || !Array.isArray(item.blocos) || item.blocos.length === 0) return null;

  const blocos = [];
  for (const raw of item.blocos) {
    const texto = String(raw?.texto || '').trim().toLocaleUpperCase('pt-BR');
    if (!texto) return null;
    const tipo = VALID_TYPES.has(raw?.tipo) ? raw.tipo : 'silaba_simples';
    const somGuia = String(raw?.som_guia || texto).trim().toLocaleLowerCase('pt-BR');
    blocos.push({
      texto,
      tipo,
      qtd_letras: [...texto].length,
      som_guia: somGuia,
    });
  }

  const joined = normalizeWordKey(blocos.map((b) => b.texto).join(''));
  if (joined !== palavra) return null;

  return {
    palavra,
    dica: typeof item.dica === 'string' ? item.dica.trim() : '',
    blocos,
  };
}

export async function mergeIntoSyllableCache(analyzedItems) {
  const cacheObj = await loadSyllableCache();
  let addedCount = 0;

  for (const raw of analyzedItems) {
    const valid = validateAnalyzedWord(raw);
    if (!valid) continue;
    cacheObj[valid.palavra] = valid;
    addedCount += 1;
  }

  if (addedCount > 0) {
    await saveSyllableCache(cacheObj);
  }
  return cacheObj;
}
