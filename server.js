import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { config, isOpenAIConfigured } from './src/config.js';
import { loadWords, addGeneratedWords } from './src/wordStore.js';
import {
  buildCacheKey,
  ensureCacheDir,
  hasCachedAudio,
  saveAudioToCache,
  streamCachedAudio,
  countCachedFiles,
} from './src/audioCache.js';
import {
  synthesizeSpeech,
  generateStructuredWords,
  analyzeWordsIntoBlocks,
} from './src/openaiService.js';
import {
  loadProgress,
  recordWordEvent,
  recordReadingChunkXP,
  buildCareerSummary,
} from './src/progressStore.js';
import {
  getKnownWordBlocksMap,
  mergeIntoSyllableCache,
  normalizeWordKey,
} from './src/syllableCache.js';
import {
  loadMaterials,
  extractTextFromFile,
  createMaterial,
  markMaterialChunkDone,
  deleteMaterial,
  extractUniqueWordsFromText,
} from './src/materialStore.js';

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const inflightAudioRequests = new Map();

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

async function readJsonBody(req, maxBytes = 128 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) {
      throw new Error('Arquivo ou requisição excede o limite permitido.');
    }
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  return raw ? JSON.parse(raw) : {};
}

async function handleAudioRequest(req, res, url) {
  const text = (url.searchParams.get('text') || '').trim();
  const speed = url.searchParams.get('speed') === 'slow' ? 'slow' : 'normal';
  const rawKind = url.searchParams.get('kind');
  const kind =
    rawKind === 'sentence' ? 'sentence' : rawKind === 'word' ? 'word' : 'block';

  const maxLen = kind === 'sentence' ? 420 : 60;
  if (!text || text.length > maxLen) {
    return sendJson(res, 400, { error: 'Parâmetro "text" inválido.' });
  }

  const fileName = buildCacheKey({ text, speed, kind });

  if (await hasCachedAudio(fileName)) {
    return streamCachedAudio(req, res, fileName, { cacheHit: true });
  }

  if (!isOpenAIConfigured()) {
    return sendJson(res, 503, {
      error: 'OpenAI TTS não configurado. Usando fallback local do navegador.',
      fallback: 'browser_tts',
    });
  }

  try {
    let pending = inflightAudioRequests.get(fileName);
    if (!pending) {
      pending = (async () => {
        const audioBuffer = await synthesizeSpeech({ text, speed, kind });
        await saveAudioToCache(fileName, audioBuffer);
      })();
      inflightAudioRequests.set(fileName, pending);
    }

    try {
      await pending;
    } finally {
      inflightAudioRequests.delete(fileName);
    }

    return streamCachedAudio(req, res, fileName, { cacheHit: false });
  } catch (err) {
    console.error('[audio] Erro ao sintetizar:', err.message);
    return sendJson(res, 503, {
      error: 'Falha ao gerar áudio via OpenAI. Usando fallback local.',
      fallback: 'browser_tts',
    });
  }
}

async function serveStatic(req, res, pathname) {
  const safePath = pathname === '/' ? '/index.html' : pathname;
  const resolved = path.resolve(config.paths.publicDir, `.${safePath}`);

  if (!resolved.startsWith(config.paths.publicDir)) {
    res.writeHead(403);
    res.end('Acesso negado');
    return;
  }

  try {
    const stat = await fs.stat(resolved);
    if (!stat.isFile()) {
      res.writeHead(404);
      res.end('Não encontrado');
      return;
    }

    const ext = path.extname(resolved).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    const data = await fs.readFile(resolved);

    res.writeHead(200, {
      'Content-Type': contentType,
      'Content-Length': data.length,
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600',
    });
    res.end(req.method === 'HEAD' ? undefined : data);
  } catch {
    res.writeHead(404);
    res.end('Arquivo não encontrado');
  }
}

function getLocalNetworkIps() {
  const interfaces = os.networkInterfaces();
  const ips = [];
  for (const list of Object.values(interfaces)) {
    for (const iface of list || []) {
      if (iface.family === 'IPv4' && !iface.internal) {
        ips.push(iface.address);
      }
    }
  }
  return ips;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const pathname = decodeURIComponent(url.pathname);

    // Health & Config
    if (pathname === '/api/health' && req.method === 'GET') {
      const [words, cachedAudioCount, materials] = await Promise.all([
        loadWords(),
        countCachedFiles(),
        loadMaterials(),
      ]);
      return sendJson(res, 200, {
        ok: true,
        openaiConfigured: isOpenAIConfigured(),
        ttsModel: config.ttsModel,
        ttsVoice: config.ttsVoice,
        wordsCount: words.length,
        cachedAudioCount,
        materialsCount: materials.length,
      });
    }

    // Words
    if (pathname === '/api/words' && req.method === 'GET') {
      const words = await loadWords();
      const nivelParam = url.searchParams.get('nivel');
      const categoriaParam = url.searchParams.get('categoria');

      let filtered = words;
      if (nivelParam && nivelParam !== 'all') {
        const nivelNum = Number(nivelParam);
        filtered = filtered.filter((w) => w.nivel === nivelNum);
      }
      if (categoriaParam && categoriaParam !== 'all') {
        filtered = filtered.filter((w) => w.categoria === categoriaParam);
      }

      return sendJson(res, 200, { words: filtered, total: words.length });
    }

    if (pathname === '/api/words/generate' && req.method === 'POST') {
      if (!isOpenAIConfigured()) {
        return sendJson(res, 503, {
          error:
            'Configure OPENAI_API_KEY no arquivo .env para gerar novas palavras automaticamente.',
          openaiConfigured: false,
        });
      }

      const body = await readJsonBody(req);
      const currentWords = await loadWords();
      const candidates = await generateStructuredWords({
        focus: body.focus,
        level: body.level,
        count: body.count,
        pattern: body.pattern,
        existingWords: currentWords.map((w) => w.palavra),
      });

      const result = await addGeneratedWords(candidates);
      return sendJson(res, 200, {
        ok: true,
        added: result.added,
        rejected: result.rejected,
        total: result.total,
      });
    }

    // Promove uma palavra analisada da leitura guiada para o banco de treino
    if (pathname === '/api/words/from-reading' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const candidate = {
        id: `rd-${Date.now().toString(36)}`,
        nivel: 3,
        categoria: 'mistas',
        palavra: body.palavra,
        dica: body.dica || 'Palavra salva da sua leitura guiada.',
        blocos: body.blocos,
      };
      const result = await addGeneratedWords([candidate]);
      return sendJson(res, 200, {
        ok: true,
        added: result.added,
        rejected: result.rejected,
        total: result.total,
      });
    }

    // Progress & Career (Duolingo-style memory + SRS)
    if (pathname === '/api/progress' && req.method === 'GET') {
      const [progress, words] = await Promise.all([loadProgress(), loadWords()]);
      const career = buildCareerSummary(progress, words);
      return sendJson(res, 200, { progress, career });
    }

    if (pathname === '/api/progress/event' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const words = await loadWords();
      const targetWord = words.find((w) => w.id === body.wordId);
      const blockTypes = targetWord
        ? [...new Set(targetWord.blocos.map((b) => b.tipo))]
        : [];

      const { progress, xpGained, wordMemory } = await recordWordEvent({
        wordId: body.wordId,
        palavra: targetWord?.palavra || body.palavra || '',
        result: body.result,
        blockTypes,
      });

      const career = buildCareerSummary(progress, words);
      return sendJson(res, 200, { ok: true, xpGained, wordMemory, progress, career });
    }

    // Materials (Upload PDF / DOCX / Texto Puro + Leitura Guiada)
    if (pathname === '/api/materials' && req.method === 'GET') {
      const materials = await loadMaterials();
      return sendJson(res, 200, { materials });
    }

    if (pathname === '/api/materials' && req.method === 'POST') {
      // Até 10 MB para suportar PDF/DOCX em base64
      const body = await readJsonBody(req, 10 * 1024 * 1024);
      let rawText = '';
      let sourceType = 'texto';
      let title = body.title || '';

      if (body.fileBase64 && body.fileName) {
        const buffer = Buffer.from(body.fileBase64, 'base64');
        const extracted = await extractTextFromFile({
          fileName: body.fileName,
          buffer,
        });
        rawText = extracted.text;
        sourceType = extracted.sourceType;
        if (!title) {
          title = path.basename(body.fileName, path.extname(body.fileName));
        }
      } else if (body.text) {
        rawText = String(body.text);
        sourceType = 'texto';
      } else {
        return sendJson(res, 400, {
          error: 'Envie um texto ou um arquivo .pdf, .docx ou .txt.',
        });
      }

      const material = await createMaterial({ title, rawText, sourceType });
      return sendJson(res, 201, { ok: true, material });
    }

    const materialAnalyzeMatch = /^\/api\/materials\/([^/]+)\/analyze$/.exec(pathname);
    if (materialAnalyzeMatch && req.method === 'POST') {
      const materialId = materialAnalyzeMatch[1];
      const body = await readJsonBody(req);
      const materials = await loadMaterials();
      const mat = materials.find((m) => m.id === materialId);
      if (!mat) return sendJson(res, 404, { error: 'Material não encontrado.' });

      const chunkIdx = Number(body.chunkIndex ?? mat.currentChunkIndex ?? 0);
      const chunk = mat.chunks[chunkIdx];
      if (!chunk) return sendJson(res, 404, { error: 'Trecho não encontrado.' });

      const uniqueWords = extractUniqueWordsFromText(chunk.text);
      let knownMap = await getKnownWordBlocksMap();
      const missing = uniqueWords.filter((w) => !knownMap[w]);

      let analyzedByAI = 0;
      let aiUnavailable = false;

      if (missing.length > 0) {
        if (isOpenAIConfigured()) {
          try {
            const aiItems = await analyzeWordsIntoBlocks(missing);
            await mergeIntoSyllableCache(aiItems);
            knownMap = await getKnownWordBlocksMap();
            analyzedByAI = aiItems.length;
          } catch (err) {
            console.error('[analyze] Erro OpenAI:', err.message);
            aiUnavailable = true;
          }
        } else {
          aiUnavailable = true;
        }
      }

      const wordsMap = {};
      for (const w of uniqueWords) {
        const key = normalizeWordKey(w);
        if (knownMap[key]) {
          wordsMap[key] = knownMap[key];
        }
      }

      return sendJson(res, 200, {
        ok: true,
        chunkIndex: chunkIdx,
        wordsMap,
        analyzedByAI,
        missingCount: uniqueWords.length - Object.keys(wordsMap).length,
        aiUnavailable,
      });
    }

    const materialProgressMatch = /^\/api\/materials\/([^/]+)\/progress$/.exec(pathname);
    if (materialProgressMatch && req.method === 'POST') {
      const materialId = materialProgressMatch[1];
      const body = await readJsonBody(req);
      const updated = await markMaterialChunkDone(
        materialId,
        body.chunkIndex,
        body.done !== false
      );
      if (!updated) return sendJson(res, 404, { error: 'Trecho ou material não encontrado.' });

      let career = null;
      let xpGained = 0;
      if (updated.newlyCompleted) {
        const [resXp, words] = await Promise.all([recordReadingChunkXP(15), loadWords()]);
        xpGained = resXp.xpGained;
        career = buildCareerSummary(resXp.progress, words);
      }

      return sendJson(res, 200, {
        ok: true,
        material: updated.material,
        xpGained,
        career,
      });
    }

    const materialDeleteMatch = /^\/api\/materials\/([^/]+)$/.exec(pathname);
    if (materialDeleteMatch && req.method === 'DELETE') {
      const deleted = await deleteMaterial(materialDeleteMatch[1]);
      if (!deleted) return sendJson(res, 404, { error: 'Material não encontrado.' });
      return sendJson(res, 200, { ok: true });
    }

    // Audio TTS + Cache
    if (pathname === '/api/audio' && (req.method === 'GET' || req.method === 'HEAD')) {
      return handleAudioRequest(req, res, url);
    }

    // Static files
    if (req.method === 'GET' || req.method === 'HEAD') {
      return serveStatic(req, res, pathname);
    }

    sendJson(res, 405, { error: 'Método não permitido.' });
  } catch (err) {
    console.error('[server] Erro inesperado:', err);
    sendJson(res, 500, { error: err.message || 'Erro interno do servidor.' });
  }
});

await ensureCacheDir();

server.listen(config.port, config.host, () => {
  console.log(`\nDecodifica rodando em:`);
  console.log(`  Local:   http://localhost:${config.port}`);
  for (const ip of getLocalNetworkIps()) {
    console.log(`  Celular: http://${ip}:${config.port}`);
  }
  console.log(
    `  OpenAI:  ${isOpenAIConfigured() ? `Ativa (${config.ttsModel} / ${config.ttsVoice})` : 'Não configurada (modo local + fallback de voz do navegador)'}\n`
  );
});
