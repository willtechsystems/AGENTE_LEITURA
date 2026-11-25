import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export const ROOT_DIR = path.resolve(__dirname, '..');

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  const content = fs.readFileSync(filePath, 'utf8');
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eqIndex = line.indexOf('=');
    if (eqIndex <= 0) continue;
    const key = line.slice(0, eqIndex).trim();
    let value = line.slice(eqIndex + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}

loadEnvFile(path.join(ROOT_DIR, '.env'));

export const config = {
  port: Number.parseInt(process.env.PORT || '3000', 10) || 3000,
  host: process.env.HOST || '0.0.0.0',
  openaiApiKey: (process.env.OPENAI_API_KEY || '').trim(),
  ttsModel: (process.env.OPENAI_TTS_MODEL || 'gpt-4o-mini-tts').trim(),
  ttsVoice: (process.env.OPENAI_TTS_VOICE || 'coral').trim(),
  chatModel: (process.env.OPENAI_CHAT_MODEL || 'gpt-4o-mini').trim(),
  paths: {
    publicDir: path.join(ROOT_DIR, 'public'),
    dataDir: path.join(ROOT_DIR, 'data'),
    wordsFile: path.join(ROOT_DIR, 'data', 'words.json'),
    progressFile: path.join(ROOT_DIR, 'data', 'progress.json'),
    materialsFile: path.join(ROOT_DIR, 'data', 'materials.json'),
    syllableCacheFile: path.join(ROOT_DIR, 'data', 'syllable_cache.json'),
    audioCacheDir: path.join(ROOT_DIR, 'cache', 'audio'),
  },
};

export function isOpenAIConfigured() {
  return Boolean(config.openaiApiKey && config.openaiApiKey.length > 10);
}
