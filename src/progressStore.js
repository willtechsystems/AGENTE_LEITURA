import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';

const REVIEW_INTERVAL_DAYS = [0, 1, 3, 7, 14];

const CAREER_LEVELS = [
  { level: 1, name: 'Início', minXp: 0 },
  { level: 2, name: 'Decodificador', minXp: 80 },
  { level: 3, name: 'Ritmo', minXp: 200 },
  { level: 4, name: 'Precisão', minXp: 380 },
  { level: 5, name: 'Fluência', minXp: 620 },
  { level: 6, name: 'Domínio', minXp: 950 },
];

function createDefaultProgress() {
  return {
    xp: 0,
    streak: 0,
    lastActiveDate: null,
    dailyGoal: 5,
    dailyCompleted: 0,
    dailyDate: null,
    words: {},
    blockStats: {
      silaba_simples: { correct: 0, wrong: 0 },
      digrafo: { correct: 0, wrong: 0 },
      encontro_consonantal: { correct: 0, wrong: 0 },
      silaba_complexa: { correct: 0, wrong: 0 },
    },
    readingsCompleted: 0,
  };
}

function getTodayKey() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function getYesterdayKey() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export async function loadProgress() {
  try {
    const raw = await fs.readFile(config.paths.progressFile, 'utf8');
    const parsed = JSON.parse(raw);
    return {
      ...createDefaultProgress(),
      ...parsed,
      words: parsed.words || {},
      blockStats: {
        ...createDefaultProgress().blockStats,
        ...(parsed.blockStats || {}),
      },
    };
  } catch {
    return createDefaultProgress();
  }
}

async function saveProgress(progress) {
  await fs.mkdir(path.dirname(config.paths.progressFile), { recursive: true });
  const tempFile = `${config.paths.progressFile}.tmp`;
  await fs.writeFile(tempFile, JSON.stringify(progress, null, 2) + '\n', 'utf8');
  await fs.rename(tempFile, config.paths.progressFile);
}

function touchActivity(progress, xpDelta = 0, countTowardDaily = false) {
  const today = getTodayKey();
  const yesterday = getYesterdayKey();

  if (progress.lastActiveDate !== today) {
    if (progress.lastActiveDate === yesterday) {
      progress.streak = (progress.streak || 0) + 1;
    } else if (!progress.lastActiveDate) {
      progress.streak = 1;
    } else {
      progress.streak = 1;
    }
    progress.lastActiveDate = today;
  }

  if (progress.dailyDate !== today) {
    progress.dailyDate = today;
    progress.dailyCompleted = 0;
  }

  if (countTowardDaily) {
    progress.dailyCompleted += 1;
  }

  progress.xp = Math.max(0, (progress.xp || 0) + xpDelta);
}

/**
 * Registra um evento de prática para memória espaçada (SRS) e carreira.
 * result: 'explored' | 'correct' | 'wrong'
 */
export async function recordWordEvent({ wordId, palavra, result, blockTypes = [] }) {
  const progress = await loadProgress();
  const now = new Date();
  const existing = progress.words[wordId] || {
    palavra: palavra || '',
    mastery: 0,
    correct: 0,
    wrong: 0,
    explored: 0,
    lastPracticed: null,
    nextReview: null,
  };

  let xpDelta = 0;
  let countDaily = false;

  if (result === 'explored') {
    existing.explored = (existing.explored || 0) + 1;
    if (existing.mastery === 0) {
      existing.mastery = 1;
      xpDelta = 5;
      countDaily = true;
    } else {
      xpDelta = 2;
    }
  } else if (result === 'correct') {
    existing.correct = (existing.correct || 0) + 1;
    existing.mastery = Math.min(3, (existing.mastery || 0) + 1);
    xpDelta = 12;
    countDaily = true;
    for (const t of blockTypes) {
      if (progress.blockStats[t]) progress.blockStats[t].correct += 1;
    }
  } else if (result === 'wrong') {
    existing.wrong = (existing.wrong || 0) + 1;
    existing.mastery = Math.max(1, (existing.mastery || 1) - 1);
    xpDelta = 0;
    for (const t of blockTypes) {
      if (progress.blockStats[t]) progress.blockStats[t].wrong += 1;
    }
  }

  const days =
    result === 'wrong'
      ? 0
      : REVIEW_INTERVAL_DAYS[Math.min(existing.mastery, REVIEW_INTERVAL_DAYS.length - 1)];
  const next = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);

  existing.palavra = palavra || existing.palavra;
  existing.lastPracticed = now.toISOString();
  existing.nextReview = next.toISOString();

  progress.words[wordId] = existing;
  touchActivity(progress, xpDelta, countDaily);
  await saveProgress(progress);

  return { progress, xpGained: xpDelta, wordMemory: existing };
}

export async function recordReadingChunkXP(xp = 15) {
  const progress = await loadProgress();
  progress.readingsCompleted = (progress.readingsCompleted || 0) + 1;
  touchActivity(progress, xp, true);
  await saveProgress(progress);
  return { progress, xpGained: xp };
}

/**
 * Monta o resumo da Carreira (estilo Duolingo, sóbrio) com as 5 unidades e fila de revisão.
 */
export function buildCareerSummary(progress, allWords) {
  const today = getTodayKey();
  const nowMs = Date.now();
  const dailyCompleted = progress.dailyDate === today ? progress.dailyCompleted || 0 : 0;

  let currentRank = CAREER_LEVELS[0];
  let nextRank = CAREER_LEVELS[1] || null;
  for (let i = 0; i < CAREER_LEVELS.length; i += 1) {
    if ((progress.xp || 0) >= CAREER_LEVELS[i].minXp) {
      currentRank = CAREER_LEVELS[i];
      nextRank = CAREER_LEVELS[i + 1] || null;
    }
  }

  const hasDigraphGroup = (word, patterns) =>
    word.blocos.some(
      (b) => b.tipo === 'digrafo' && patterns.some((p) => b.texto.toUpperCase().includes(p))
    );

  const unitDefs = [
    {
      id: 'unit-1',
      title: 'Unidade 1 · Base de 2 letras',
      subtitle: 'Sílabas simples sem soletrar letra por letra',
      filter: (w) => w.categoria === 'silabas_simples',
    },
    {
      id: 'unit-2',
      title: 'Unidade 2 · Dígrafos NH, LH e CH',
      subtitle: '3 letras que formam um único som',
      filter: (w) => w.categoria === 'digrafos' && hasDigraphGroup(w, ['NH', 'LH', 'CH']),
    },
    {
      id: 'unit-3',
      title: 'Unidade 3 · Dígrafos RR, SS e QU',
      subtitle: 'Som forte entre vogais e U mudo',
      filter: (w) => w.categoria === 'digrafos' && hasDigraphGroup(w, ['RR', 'SS', 'QU']),
    },
    {
      id: 'unit-4',
      title: 'Unidade 4 · Encontros Consonantais',
      subtitle: 'TR, PR, BL, CR, FR, GR, PL',
      filter: (w) => w.categoria === 'encontros_consonantais' && w.nivel <= 2,
    },
    {
      id: 'unit-5',
      title: 'Unidade 5 · Combinações e Desafio',
      subtitle: 'Palavras mais longas, nível 3 e extras',
      filter: (w) => w.nivel === 3 || w.categoria === 'mistas',
    },
  ];

  const units = unitDefs.map((def, idx) => {
    const unitWords = allWords.filter(def.filter);
    const mastered = unitWords.filter((w) => (progress.words[w.id]?.mastery || 0) >= 2).length;
    const practiced = unitWords.filter((w) => (progress.words[w.id]?.mastery || 0) >= 1).length;
    const pct = unitWords.length ? Math.round((mastered / unitWords.length) * 100) : 0;
    return {
      id: def.id,
      order: idx + 1,
      title: def.title,
      subtitle: def.subtitle,
      wordIds: unitWords.map((w) => w.id),
      total: unitWords.length,
      practiced,
      mastered,
      percent: pct,
    };
  });

  // Palavras que precisam de revisão hoje (já praticadas e nextReview <= agora, ou mastery === 1 com erro)
  const dueReviewIds = [];
  let masteredTotal = 0;
  let learningTotal = 0;

  for (const w of allWords) {
    const mem = progress.words[w.id];
    if (!mem) continue;
    if (mem.mastery >= 2) masteredTotal += 1;
    else if (mem.mastery === 1) learningTotal += 1;

    if (mem.nextReview && new Date(mem.nextReview).getTime() <= nowMs) {
      dueReviewIds.push(w.id);
    }
  }

  return {
    xp: progress.xp || 0,
    streak: progress.streak || 0,
    dailyGoal: progress.dailyGoal || 5,
    dailyCompleted,
    rank: currentRank,
    nextRank,
    masteredTotal,
    learningTotal,
    totalWords: allWords.length,
    dueReviewIds,
    readingsCompleted: progress.readingsCompleted || 0,
    blockStats: progress.blockStats,
    units,
  };
}
