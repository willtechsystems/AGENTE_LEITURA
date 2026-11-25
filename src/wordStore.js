import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';

const VALID_BLOCK_TYPES = new Set([
  'silaba_simples',
  'digrafo',
  'encontro_consonantal',
  'silaba_complexa',
]);

const VALID_CATEGORIES = new Set([
  'silabas_simples',
  'digrafos',
  'encontros_consonantais',
  'mistas',
]);

function normalizeForComparison(str) {
  return String(str || '')
    .trim()
    .toLocaleLowerCase('pt-BR')
    .normalize('NFC');
}

export function validateWordEntry(entry) {
  if (!entry || typeof entry !== 'object') {
    return { valid: false, reason: 'Objeto de palavra inválido.' };
  }

  const palavra = String(entry.palavra || '').trim().toLocaleLowerCase('pt-BR');
  if (!palavra || palavra.length < 2 || /\s/.test(palavra)) {
    return { valid: false, reason: 'Palavra deve ser única e sem espaços.' };
  }

  const nivel = Number(entry.nivel);
  if (!Number.isInteger(nivel) || nivel < 1 || nivel > 3) {
    return { valid: false, reason: 'Nível deve ser 1, 2 ou 3.' };
  }

  const categoria = VALID_CATEGORIES.has(entry.categoria)
    ? entry.categoria
    : 'mistas';

  if (!Array.isArray(entry.blocos) || entry.blocos.length < 2) {
    return { valid: false, reason: 'A palavra precisa ter pelo menos 2 blocos.' };
  }

  const blocos = [];
  for (const rawBlock of entry.blocos) {
    if (!rawBlock || typeof rawBlock !== 'object') {
      return { valid: false, reason: 'Bloco inválido.' };
    }
    const texto = String(rawBlock.texto || '').trim().toLocaleUpperCase('pt-BR');
    if (!texto) {
      return { valid: false, reason: 'Texto do bloco vazio.' };
    }
    const tipo = VALID_BLOCK_TYPES.has(rawBlock.tipo)
      ? rawBlock.tipo
      : 'silaba_simples';
    const somGuia = String(rawBlock.som_guia || texto)
      .trim()
      .toLocaleLowerCase('pt-BR');
    const qtdLetras = [...texto].length;

    blocos.push({
      texto,
      tipo,
      qtd_letras: qtdLetras,
      som_guia: somGuia,
    });
  }

  const joined = normalizeForComparison(blocos.map((b) => b.texto).join(''));
  if (joined !== normalizeForComparison(palavra)) {
    return {
      valid: false,
      reason: `A junção dos blocos ("${joined}") não corresponde à palavra ("${palavra}").`,
    };
  }

  const id = String(entry.id || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-_]/g, '');

  const normalized = {
    id: id || `ai-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    nivel,
    categoria,
    palavra,
    blocos,
  };

  if (entry.dica && typeof entry.dica === 'string' && entry.dica.trim()) {
    normalized.dica = entry.dica.trim();
  }

  return { valid: true, value: normalized };
}

export async function loadWords() {
  const raw = await fs.readFile(config.paths.wordsFile, 'utf8');
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error('Dataset de palavras inválido.');
  }
  return parsed;
}

export async function addGeneratedWords(candidates) {
  const existing = await loadWords();
  const existingWordsSet = new Set(
    existing.map((w) => normalizeForComparison(w.palavra))
  );
  const existingIdsSet = new Set(existing.map((w) => w.id));

  const added = [];
  const rejected = [];

  for (const candidate of candidates) {
    const result = validateWordEntry(candidate);
    if (!result.valid) {
      rejected.push({ palavra: candidate?.palavra || '?', reason: result.reason });
      continue;
    }

    const wordObj = result.value;
    const key = normalizeForComparison(wordObj.palavra);
    if (existingWordsSet.has(key)) {
      rejected.push({ palavra: wordObj.palavra, reason: 'Palavra já existe no dataset.' });
      continue;
    }

    while (existingIdsSet.has(wordObj.id)) {
      wordObj.id = `${wordObj.id}-${Math.random().toString(36).slice(2, 5)}`;
    }

    existingWordsSet.add(key);
    existingIdsSet.add(wordObj.id);
    existing.push(wordObj);
    added.push(wordObj);
  }

  if (added.length > 0) {
    const tempFile = `${config.paths.wordsFile}.tmp`;
    await fs.mkdir(path.dirname(config.paths.wordsFile), { recursive: true });
    await fs.writeFile(tempFile, JSON.stringify(existing, null, 2) + '\n', 'utf8');
    await fs.rename(tempFile, config.paths.wordsFile);
  }

  return { added, rejected, total: existing.length };
}
