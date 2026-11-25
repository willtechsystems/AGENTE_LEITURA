/**
 * Decodifica — Frontend mobile-first:
 * 1. Trilha de Carreira & Memória Espaçada (SRS)
 * 2. Treino de Blocos (Explorar, Montar, Qual é o bloco?)
 * 3. Meus Textos (Upload PDF, DOCX, TXT ou Texto Puro com Leitura Guiada por Blocos)
 */

const SILENT_WAV_DATA_URI =
  'data:audio/wav;base64,UklGRigAAABXQVZFZm10IBIAAAABAAEARKwAAIhYAQACABAAAABkYXRhAgAAAAEA';

const TYPE_LABELS = {
  silaba_simples: 'Simples',
  digrafo: 'Dígrafo',
  encontro_consonantal: 'Encontro',
  silaba_complexa: 'Complexa',
};

const CATEGORY_LABELS = {
  silabas_simples: 'Sílabas simples',
  digrafos: 'Dígrafos',
  encontros_consonantais: 'Encontros consonantais',
  mistas: 'Mistas',
};

const MASTERY_LABELS = {
  0: { text: 'Nova', cls: '' },
  1: { text: 'Em aprendizado', cls: 'badge-learning' },
  2: { text: 'Consolidando', cls: 'badge-done' },
  3: { text: 'Dominada', cls: 'badge-done' },
};

class MobileAudioEngine {
  constructor() {
    this.audio = new Audio();
    this.audio.preload = 'auto';
    this.audio.playsInline = true;
    this.unlocked = false;
    this.playbackToken = 0;
    this.openaiEnabled = false;
    this.preferredVoice = null;
    this.initVoices();
  }

  initVoices() {
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) return;
    const pickVoice = () => {
      const voices = window.speechSynthesis.getVoices() || [];
      this.preferredVoice =
        voices.find((v) => v.lang.toLowerCase() === 'pt-br') ||
        voices.find((v) => v.lang.toLowerCase().startsWith('pt')) ||
        null;
    };
    pickVoice();
    window.speechSynthesis.addEventListener?.('voiceschanged', pickVoice);
  }

  setOpenAIEnabled(enabled) {
    this.openaiEnabled = Boolean(enabled);
  }

  unlock() {
    if (this.unlocked) return;
    this.unlocked = true;
    try {
      this.audio.src = SILENT_WAV_DATA_URI;
      const p = this.audio.play();
      if (p && typeof p.then === 'function') {
        p.then(() => {
          this.audio.pause();
          this.audio.currentTime = 0;
        }).catch(() => {});
      }
    } catch {
      // Ignora
    }
  }

  stop() {
    this.playbackToken += 1;
    try {
      this.audio.pause();
      this.audio.currentTime = 0;
    } catch {
      // Ignora
    }
    if ('speechSynthesis' in window) {
      try {
        window.speechSynthesis.cancel();
      } catch {
        // Ignora
      }
    }
  }

  async play({ text, speed = 'normal', kind = 'block' }) {
    this.unlock();
    this.stop();
    const token = this.playbackToken;
    if (!text) return false;

    if (this.openaiEnabled) {
      const ok = await this.playFromServer({ text, speed, kind, token });
      if (token !== this.playbackToken) return false;
      if (ok) return true;
    }

    return this.playBrowserSpeech({ text, speed, token });
  }

  playFromServer({ text, speed, kind, token }) {
    return new Promise((resolve) => {
      const params = new URLSearchParams({
        text: String(text),
        speed: speed === 'slow' ? 'slow' : 'normal',
        kind: kind === 'sentence' ? 'sentence' : kind === 'word' ? 'word' : 'block',
      });
      const url = `/api/audio?${params.toString()}`;

      let settled = false;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(result);
      };

      const onEnded = () => finish(true);
      const onError = () => finish(false);
      const cleanup = () => {
        this.audio.removeEventListener('ended', onEnded);
        this.audio.removeEventListener('error', onError);
      };

      this.audio.addEventListener('ended', onEnded, { once: true });
      this.audio.addEventListener('error', onError, { once: true });

      try {
        this.audio.src = url;
        const playPromise = this.audio.play();
        if (playPromise && typeof playPromise.then === 'function') {
          playPromise.catch((err) => {
            if (token !== this.playbackToken || err?.name === 'AbortError') {
              finish(true);
            } else {
              finish(false);
            }
          });
        }
      } catch {
        finish(false);
      }
    });
  }

  playBrowserSpeech({ text, speed, token }) {
    return new Promise((resolve) => {
      if (!('speechSynthesis' in window)) {
        showToast('Áudio indisponível neste navegador. Configure a OpenAI API para voz pt-BR.');
        resolve(false);
        return;
      }

      try {
        window.speechSynthesis.cancel();
        const utterance = new SpeechSynthesisUtterance(String(text));
        utterance.lang = 'pt-BR';
        if (this.preferredVoice) utterance.voice = this.preferredVoice;
        utterance.rate = speed === 'slow' ? 0.72 : 0.94;
        utterance.pitch = 1.0;

        utterance.onend = () => resolve(true);
        utterance.onerror = () => resolve(token !== this.playbackToken);

        window.speechSynthesis.speak(utterance);
      } catch {
        resolve(false);
      }
    });
  }

  async playSequence(wordObj, speed, onHighlightBlock) {
    this.unlock();
    this.stop();
    const sequenceToken = this.playbackToken;

    for (let i = 0; i < wordObj.blocos.length; i += 1) {
      if (sequenceToken !== this.playbackToken) {
        onHighlightBlock(-1);
        return;
      }
      onHighlightBlock(i);
      const bloco = wordObj.blocos[i];
      await this.playStepInternal(
        { text: bloco.som_guia || bloco.texto, speed, kind: 'block' },
        sequenceToken
      );
      if (sequenceToken !== this.playbackToken) {
        onHighlightBlock(-1);
        return;
      }
      await delay(230);
    }

    onHighlightBlock(-1);
    if (sequenceToken !== this.playbackToken) return;
    await delay(140);
    await this.playStepInternal(
      { text: wordObj.palavra, speed, kind: 'word' },
      sequenceToken
    );
  }

  async playStepInternal({ text, speed, kind }, expectedToken) {
    if (expectedToken !== this.playbackToken) return;
    if (this.openaiEnabled) {
      const ok = await this.playFromServer({ text, speed, kind, token: expectedToken });
      if (expectedToken !== this.playbackToken || ok) return;
    }
    await this.playBrowserSpeech({ text, speed, token: expectedToken });
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shuffleArray(items) {
  const arr = [...items];
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function normalizeWordKey(word) {
  return String(word || '').trim().toLocaleLowerCase('pt-BR').normalize('NFC');
}

function generateDistractorTexts(targetBlock, allWords, count = 2) {
  const target = targetBlock.texto.toUpperCase();
  const candidates = new Set();

  if (target.length === 3) {
    const dropSecond = target[0] + target[2];
    if (dropSecond !== target && !dropSecond.startsWith('Q')) candidates.add(dropSecond);
    if (target[1] === 'R') candidates.add(target[0] + 'L' + target[2]);
    if (target[1] === 'L') candidates.add(target[0] + 'R' + target[2]);
    if (target.startsWith('LH')) candidates.add('NH' + target[2]);
    if (target.startsWith('NH')) candidates.add('LH' + target[2]);
    if (target.startsWith('CH')) candidates.add('C' + target[2]);
    if (target.startsWith('QU')) candidates.add('C' + target[2]);
    if (target.startsWith('RR')) candidates.add('R' + target[2]);
    if (target.startsWith('SS')) candidates.add('S' + target[2]);
  } else if (target.length === 2) {
    candidates.add(target[0] + 'R' + target[1]);
    candidates.add(target[0] + 'L' + target[1]);
  }

  const pool = shuffleArray(
    allWords.flatMap((w) => w.blocos.map((b) => b.texto.toUpperCase()))
  );
  for (const text of pool) {
    if (candidates.size >= count + 2) break;
    if (text !== target) candidates.add(text);
  }

  return [...candidates].filter((c) => c && c !== target).slice(0, count);
}

// Estado global
const state = {
  section: 'career', // 'career' | 'practice' | 'reading'
  allWords: [],
  filteredWords: [],
  currentIndex: 0,
  mode: 'explore', // 'explore' | 'build' | 'quiz'
  category: 'all',
  level: 'all',
  scope: null, // { label, wordIds: Set } quando vem de uma Unidade ou Revisão
  speed: 'normal',
  showWholeWord: true,
  showTip: false,
  playingBlockIndex: -1,
  openaiConfigured: false,
  progress: { words: {} },
  career: null,
  buildState: null,
  quizState: null,
  // Meus Textos (Leitura Guiada)
  materials: [],
  activeMaterialId: null,
  activeChunkIndex: 0,
  chunkWordsMap: {}, // { palavra_lower: { palavra, dica, blocos } }
  analyzingChunk: false,
  selectedReadingWord: null,
  readingPlayingBlockIndex: -1,
};

const audioEngine = new MobileAudioEngine();

const els = {
  audioStatusBadge: document.getElementById('audioStatusBadge'),
  xpPill: document.getElementById('xpPill'),
  contextHint: document.getElementById('contextHint'),
  speedToggleBtn: document.getElementById('speedToggleBtn'),
  speedLabel: document.getElementById('speedLabel'),
  sectionCareer: document.getElementById('sectionCareer'),
  sectionPractice: document.getElementById('sectionPractice'),
  sectionReading: document.getElementById('sectionReading'),
  careerContainer: document.getElementById('careerContainer'),
  readingContainer: document.getElementById('readingContainer'),
  activeScopeBanner: document.getElementById('activeScopeBanner'),
  activeScopeText: document.getElementById('activeScopeText'),
  clearScopeBtn: document.getElementById('clearScopeBtn'),
  practiceFilters: document.getElementById('practiceFilters'),
  practiceCard: document.getElementById('practiceCard'),
  wordCounter: document.getElementById('wordCounter'),
  practicedCounter: document.getElementById('practicedCounter'),
  progressFill: document.getElementById('progressFill'),
  categoryFilters: document.getElementById('categoryFilters'),
  levelFilters: document.getElementById('levelFilters'),
  prevWordBtn: document.getElementById('prevWordBtn'),
  nextWordBtn: document.getElementById('nextWordBtn'),
  shuffleBtn: document.getElementById('shuffleBtn'),
  themeToggleBtn: document.getElementById('themeToggleBtn'),
  openGeneratorBtn: document.getElementById('openGeneratorBtn'),
  closeGeneratorBtn: document.getElementById('closeGeneratorBtn'),
  generatorModal: document.getElementById('generatorModal'),
  generatorOfflineNotice: document.getElementById('generatorOfflineNotice'),
  generatorForm: document.getElementById('generatorForm'),
  submitGeneratorBtn: document.getElementById('submitGeneratorBtn'),
  uploadModal: document.getElementById('uploadModal'),
  closeUploadBtn: document.getElementById('closeUploadBtn'),
  uploadForm: document.getElementById('uploadForm'),
  materialTitleInput: document.getElementById('materialTitleInput'),
  materialFileInput: document.getElementById('materialFileInput'),
  materialTextInput: document.getElementById('materialTextInput'),
  submitUploadBtn: document.getElementById('submitUploadBtn'),
  toast: document.getElementById('toast'),
};

let toastTimer = null;
function showToast(message) {
  els.toast.textContent = message;
  els.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    els.toast.hidden = true;
  }, 3200);
}

function updateTopXpUI() {
  if (!state.career) return;
  els.xpPill.textContent = `${state.career.xp} XP · ${state.career.streak}d`;
}

function switchSection(section) {
  state.section = section;
  audioEngine.stop();

  els.sectionCareer.hidden = section !== 'career';
  els.sectionPractice.hidden = section !== 'practice';
  els.sectionReading.hidden = section !== 'reading';

  document.querySelectorAll('.primary-tab').forEach((tab) => {
    const active = tab.dataset.section === section;
    tab.classList.toggle('is-active', active);
    tab.setAttribute('aria-selected', String(active));
  });

  if (section === 'career') {
    els.contextHint.textContent = 'Trilha de evolução e memória';
    renderCareer();
  } else if (section === 'practice') {
    els.contextHint.textContent = state.scope ? state.scope.label : 'Treino por blocos silábicos';
    renderPractice();
  } else {
    els.contextHint.textContent = 'Acompanhamento de leitura';
    renderReading();
  }
}

async function sendProgressEvent(wordId, result) {
  try {
    const res = await fetch('/api/progress/event', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ wordId, result }),
    });
    const data = await res.json();
    if (res.ok && data.career) {
      state.progress = data.progress;
      state.career = data.career;
      updateTopXpUI();
      if (data.xpGained > 0 && result === 'correct') {
        showToast(`+${data.xpGained} XP · Memória atualizada!`);
      }
      if (state.section === 'practice') updateProgressUI();
    }
  } catch {
    // Não interrompe a prática
  }
}

/* ==================== SEÇÃO 1: TRILHA (CARREIRA & MEMÓRIA) ==================== */
function renderCareer() {
  const c = state.career;
  if (!c) {
    els.careerContainer.innerHTML = '<div class="empty-state">Carregando trilha...</div>';
    return;
  }

  const dailyPct = Math.min(100, Math.round((c.dailyCompleted / Math.max(1, c.dailyGoal)) * 100));
  const nextRankHint = c.nextRank
    ? `Faltam ${Math.max(0, c.nextRank.minXp - c.xp)} XP para ${c.nextRank.name}`
    : 'Nível máximo atingido';

  const reviewHtml =
    c.dueReviewIds.length > 0
      ? `
      <div class="review-banner">
        <div>
          <h3>Revisão de memória (${c.dueReviewIds.length})</h3>
          <p>Palavras prontas para reforçar hoje e fixar de vez.</p>
        </div>
        <button type="button" class="action-btn action-btn-primary" data-career-action="start-review">
          Revisar
        </button>
      </div>
    `
      : '';

  const unitsHtml = c.units
    .map(
      (u) => `
      <button type="button" class="unit-card" data-career-action="open-unit" data-unit-id="${u.id}">
        <div class="unit-card-top">
          <div>
            <h3 class="unit-title">${escapeHtml(u.title)}</h3>
            <p class="unit-subtitle">${escapeHtml(u.subtitle)}</p>
          </div>
          <span class="unit-pct">${u.mastered}/${u.total}</span>
        </div>
        <div class="progress-track">
          <div class="progress-fill" style="width: ${u.percent}%"></div>
        </div>
      </button>
    `
    )
    .join('');

  els.careerContainer.innerHTML = `
    <div class="career-hero">
      <div class="career-hero-top">
        <div>
          <span class="rank-label">Nível ${c.rank.level}</span>
          <h2 class="rank-title">${escapeHtml(c.rank.name)}</h2>
        </div>
        <span class="badge">${nextRankHint}</span>
      </div>

      <div class="stats-grid">
        <div class="stat-box">
          <span class="stat-value">${c.masteredTotal}/${c.totalWords}</span>
          <span class="stat-label">Dominadas</span>
        </div>
        <div class="stat-box">
          <span class="stat-value">${c.streak} dia${c.streak === 1 ? '' : 's'}</span>
          <span class="stat-label">Sequência</span>
        </div>
        <div class="stat-box">
          <span class="stat-value">${c.dailyCompleted}/${c.dailyGoal}</span>
          <span class="stat-label">Meta hoje</span>
        </div>
      </div>

      <div class="progress-strip">
        <div class="progress-meta">
          <span>Meta diária</span>
          <span>${dailyPct}%</span>
        </div>
        <div class="progress-track">
          <div class="progress-fill" style="width: ${dailyPct}%"></div>
        </div>
      </div>
    </div>

    ${reviewHtml}

    <h3 class="section-heading">Sua Trilha</h3>
    ${unitsHtml}
  `;
}

els.careerContainer.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-career-action]');
  if (!btn || !state.career) return;
  const action = btn.dataset.careerAction;

  if (action === 'start-review') {
    state.scope = {
      label: `Revisão de memória (${state.career.dueReviewIds.length} palavras)`,
      wordIds: new Set(state.career.dueReviewIds),
    };
    applyFilters();
    switchSection('practice');
    return;
  }

  if (action === 'open-unit') {
    const unit = state.career.units.find((u) => u.id === btn.dataset.unitId);
    if (!unit || unit.wordIds.length === 0) {
      showToast('Esta unidade ainda não tem palavras.');
      return;
    }
    state.scope = {
      label: unit.title,
      wordIds: new Set(unit.wordIds),
    };
    applyFilters();
    switchSection('practice');
  }
});

/* ==================== SEÇÃO 2: TREINAR BLOCOS ==================== */
function getCurrentWord() {
  if (!state.filteredWords.length) return null;
  return state.filteredWords[state.currentIndex] || state.filteredWords[0];
}

function applyFilters({ keepWordId = null } = {}) {
  if (state.scope) {
    state.filteredWords = state.allWords.filter((w) => state.scope.wordIds.has(w.id));
    els.activeScopeBanner.hidden = false;
    els.activeScopeText.textContent = state.scope.label;
    els.practiceFilters.hidden = true;
  } else {
    els.activeScopeBanner.hidden = true;
    els.practiceFilters.hidden = false;
    state.filteredWords = state.allWords.filter((w) => {
      const matchCategory = state.category === 'all' || w.categoria === state.category;
      const matchLevel = state.level === 'all' || String(w.nivel) === String(state.level);
      return matchCategory && matchLevel;
    });
  }

  if (keepWordId) {
    const idx = state.filteredWords.findIndex((w) => w.id === keepWordId);
    state.currentIndex = idx >= 0 ? idx : 0;
  } else {
    state.currentIndex = 0;
  }

  resetModeSubstates();
  renderPractice();
}

function resetModeSubstates() {
  audioEngine.stop();
  state.playingBlockIndex = -1;
  state.showTip = false;
  state.buildState = null;
  state.quizState = null;
}

function updateProgressUI() {
  const total = state.filteredWords.length;
  const current = total ? state.currentIndex + 1 : 0;
  els.wordCounter.textContent = `${current} / ${total}`;

  const masteredInFilter = state.filteredWords.filter(
    (w) => (state.progress.words?.[w.id]?.mastery || 0) >= 2
  ).length;
  els.practicedCounter.textContent = `${masteredInFilter} dominada${masteredInFilter === 1 ? '' : 's'}`;

  const pct = total ? Math.round((current / total) * 100) : 0;
  els.progressFill.style.width = `${pct}%`;
}

function createDotsHtml(count) {
  return `<span class="block-dots" aria-hidden="true">${'<i class="block-dot"></i>'.repeat(count)}</span>`;
}

function renderPractice() {
  updateProgressUI();
  const word = getCurrentWord();

  if (!word) {
    els.practiceCard.innerHTML = `
      <div class="empty-state">
        Nenhuma palavra encontrada para este filtro.<br/>
        Tente selecionar <strong>Todas</strong> ou outro nível.
      </div>
    `;
    return;
  }

  if (state.mode === 'explore') renderExploreMode(word);
  else if (state.mode === 'build') renderBuildMode(word);
  else renderQuizMode(word);
}

function renderCardHeader(word) {
  const mem = state.progress.words?.[word.id];
  const mastery = mem?.mastery || 0;
  const masteryInfo = MASTERY_LABELS[mastery] || MASTERY_LABELS[0];
  const catLabel = CATEGORY_LABELS[word.categoria] || 'Prática';
  return `
    <div class="card-header">
      <div class="meta-badges">
        <span class="badge">Nível ${word.nivel}</span>
        <span class="badge">${catLabel}</span>
        <span class="badge ${masteryInfo.cls}">${masteryInfo.text}</span>
      </div>
      <span class="badge">${word.blocos.length} blocos</span>
    </div>
  `;
}

function renderExploreMode(word) {
  const blocksHtml = word.blocos
    .map((bloco, index) => {
      const label = TYPE_LABELS[bloco.tipo] || 'Bloco';
      const playingClass = state.playingBlockIndex === index ? 'is-playing' : '';
      return `
        <button
          type="button"
          class="syllable-block type-${bloco.tipo} ${playingClass}"
          data-action="play-block"
          data-index="${index}"
        >
          <span class="block-text">${escapeHtml(bloco.texto)}</span>
          ${createDotsHtml(bloco.qtd_letras)}
          <span class="block-meta">${bloco.qtd_letras} letras · ${label}</span>
        </button>
      `;
    })
    .join('');

  els.practiceCard.innerHTML = `
    ${renderCardHeader(word)}
    <p class="instruction-line">Toque em cada bloco para ouvir o som junto, sem separar letra por letra.</p>

    <div class="blocks-stage">${blocksHtml}</div>

    <div class="whole-word-box">
      <div>
        <span class="whole-word-label">Palavra inteira</span>
        <span class="whole-word-value">${state.showWholeWord ? escapeHtml(word.palavra) : '• • • • •'}</span>
      </div>
      <button type="button" class="mini-chip" data-action="toggle-whole-word">
        ${state.showWholeWord ? 'Ocultar' : 'Mostrar'}
      </button>
    </div>

    <div class="actions-grid">
      <button type="button" class="action-btn action-btn-primary" data-action="play-sequence">
        Ouvir passo a passo
      </button>
      <button type="button" class="action-btn" data-action="play-word">
        Palavra inteira
      </button>
    </div>

    ${
      word.dica
        ? `
      <button type="button" class="tip-toggle" data-action="toggle-tip">
        ${state.showTip ? '▾ Ocultar dica do som' : '▸ Ver dica do som'}
      </button>
      ${state.showTip ? `<div class="tip-box">${escapeHtml(word.dica)}</div>` : ''}
    `
        : ''
    }
  `;
}

function ensureBuildState(word) {
  if (state.buildState && state.buildState.wordId === word.id) return state.buildState;
  const focusBlock = word.blocos.find((b) => b.tipo !== 'silaba_simples') || word.blocos[0];
  const distractors = generateDistractorTexts(focusBlock, state.allWords, 1);

  const tiles = [
    ...word.blocos.map((b, idx) => ({
      uid: `real-${idx}`,
      texto: b.texto,
      som_guia: b.som_guia,
      qtd_letras: b.qtd_letras,
    })),
    ...distractors.map((texto, idx) => ({
      uid: `dist-${idx}`,
      texto,
      som_guia: texto.toLocaleLowerCase('pt-BR'),
      qtd_letras: [...texto].length,
    })),
  ];

  state.buildState = {
    wordId: word.id,
    tiles: shuffleArray(tiles),
    slots: new Array(word.blocos.length).fill(null),
    status: 'idle',
  };
  return state.buildState;
}

function renderBuildMode(word) {
  const build = ensureBuildState(word);
  const slotsHtml = build.slots
    .map((tileUid, idx) => {
      const tile = build.tiles.find((t) => t.uid === tileUid);
      let cls = '';
      if (tile) {
        cls = 'is-filled';
        if (build.status === 'correct') cls = 'is-correct';
        if (build.status === 'wrong') {
          cls = tile.texto === word.blocos[idx].texto ? 'is-correct' : 'is-wrong';
        }
      }
      return `
        <button type="button" class="build-slot ${cls}" data-action="remove-slot" data-slot-index="${idx}">
          ${tile ? escapeHtml(tile.texto) : idx + 1}
        </button>
      `;
    })
    .join('');

  const usedSet = new Set(build.slots.filter(Boolean));
  const trayHtml = build.tiles
    .map((tile) => {
      const usedClass = usedSet.has(tile.uid) ? 'is-used' : '';
      return `
        <button type="button" class="tray-tile ${usedClass}" data-action="pick-tile" data-uid="${tile.uid}">
          <span>${escapeHtml(tile.texto)}</span>
          <span class="tray-tile-count">${tile.qtd_letras} letras</span>
        </button>
      `;
    })
    .join('');

  let feedbackHtml = '';
  if (build.status === 'correct') {
    feedbackHtml = `
      <div class="feedback-banner is-success">
        <span>Correto: <strong>${escapeHtml(word.palavra)}</strong></span>
        <button type="button" class="mini-chip" data-action="go-next">Próxima →</button>
      </div>
    `;
  } else if (build.status === 'wrong') {
    feedbackHtml = `
      <div class="feedback-banner is-error">
        <span>Toque nos blocos vermelhos para trocar.</span>
        <button type="button" class="mini-chip" data-action="reset-build">Limpar</button>
      </div>
    `;
  }

  els.practiceCard.innerHTML = `
    ${renderCardHeader(word)}
    <p class="instruction-line">Ouça a palavra e monte na ordem certa tocando nos blocos.</p>

    <div class="actions-grid">
      <button type="button" class="action-btn action-btn-primary action-btn-full" data-action="play-word">
        Ouvir palavra alvo
      </button>
    </div>

    <div class="slots-row">${slotsHtml}</div>
    ${feedbackHtml}
    <p class="tray-label">Blocos disponíveis (toque para ouvir e encaixar)</p>
    <div class="tray-grid">${trayHtml}</div>
  `;
}

function ensureQuizState(word) {
  if (state.quizState && state.quizState.wordId === word.id) return state.quizState;
  let targetIndex = word.blocos.findIndex((b) => b.tipo !== 'silaba_simples');
  if (targetIndex < 0) targetIndex = Math.floor(Math.random() * word.blocos.length);

  const targetBlock = word.blocos[targetIndex];
  const distractors = generateDistractorTexts(targetBlock, state.allWords, 3);

  const options = shuffleArray([
    {
      texto: targetBlock.texto,
      som_guia: targetBlock.som_guia,
      qtd_letras: targetBlock.qtd_letras,
      isCorrect: true,
    },
    ...distractors.map((texto) => ({
      texto,
      som_guia: texto.toLocaleLowerCase('pt-BR'),
      qtd_letras: [...texto].length,
      isCorrect: false,
    })),
  ]);

  state.quizState = {
    wordId: word.id,
    targetIndex,
    options,
    solved: false,
    wrongAttempts: new Set(),
  };
  return state.quizState;
}

function renderQuizMode(word) {
  const quiz = ensureQuizState(word);
  const targetBlock = word.blocos[quiz.targetIndex];

  const blocksHtml = word.blocos
    .map((bloco, index) => {
      if (index === quiz.targetIndex && !quiz.solved) {
        return `
          <button type="button" class="quiz-slot-missing" data-action="play-quiz-target">
            <strong>?</strong>
            <span>${targetBlock.qtd_letras} letras</span>
          </button>
        `;
      }
      const label = TYPE_LABELS[bloco.tipo] || 'Bloco';
      return `
        <button type="button" class="syllable-block type-${bloco.tipo}" data-action="play-block" data-index="${index}">
          <span class="block-text">${escapeHtml(bloco.texto)}</span>
          ${createDotsHtml(bloco.qtd_letras)}
          <span class="block-meta">${bloco.qtd_letras} letras · ${label}</span>
        </button>
      `;
    })
    .join('');

  const optionsHtml = quiz.options
    .map((opt) => {
      let cls = '';
      if (quiz.solved && opt.isCorrect) cls = 'is-correct';
      else if (quiz.wrongAttempts.has(opt.texto)) cls = 'is-wrong';
      return `
        <button type="button" class="quiz-option ${cls}" data-action="answer-quiz" data-texto="${escapeHtml(opt.texto)}">
          <span>${escapeHtml(opt.texto)}</span>
          <span class="tray-tile-count">${opt.qtd_letras} letras</span>
        </button>
      `;
    })
    .join('');

  let feedbackHtml = '';
  if (quiz.solved) {
    feedbackHtml = `
      <div class="feedback-banner is-success">
        <span>Correto! <strong>${escapeHtml(targetBlock.texto)}</strong> completa <strong>${escapeHtml(word.palavra)}</strong>.</span>
        <button type="button" class="mini-chip" data-action="go-next">Próxima →</button>
      </div>
    `;
  } else if (quiz.wrongAttempts.size > 0) {
    feedbackHtml = `
      <div class="feedback-banner is-error">
        <span>Compare o som e tente outro bloco.</span>
      </div>
    `;
  }

  els.practiceCard.innerHTML = `
    ${renderCardHeader(word)}
    <p class="instruction-line">Ouça o som que falta e escolha o bloco correspondente.</p>

    <div class="blocks-stage">${blocksHtml}</div>

    <div class="actions-grid">
      <button type="button" class="action-btn action-btn-primary" data-action="play-quiz-target">
        Ouvir o bloco
      </button>
      <button type="button" class="action-btn" data-action="play-word">
        Ouvir palavra
      </button>
    </div>

    ${feedbackHtml}
    <div class="quiz-options">${optionsHtml}</div>
  `;
}

els.practiceCard.addEventListener('click', async (event) => {
  const btn = event.target.closest('[data-action]');
  if (!btn) return;
  const action = btn.dataset.action;
  const word = getCurrentWord();
  if (!word) return;

  if (action === 'play-block') {
    const idx = Number(btn.dataset.index);
    const bloco = word.blocos[idx];
    if (!bloco) return;
    state.playingBlockIndex = idx;
    renderPractice();
    await audioEngine.play({
      text: bloco.som_guia || bloco.texto,
      speed: state.speed,
      kind: 'block',
    });
    if (state.playingBlockIndex === idx) {
      state.playingBlockIndex = -1;
      renderPractice();
    }
    return;
  }

  if (action === 'play-word') {
    await audioEngine.play({ text: word.palavra, speed: state.speed, kind: 'word' });
    if (state.mode === 'explore') sendProgressEvent(word.id, 'explored');
    return;
  }

  if (action === 'play-sequence') {
    await audioEngine.playSequence(word, state.speed, (activeIndex) => {
      state.playingBlockIndex = activeIndex;
      renderPractice();
    });
    sendProgressEvent(word.id, 'explored');
    return;
  }

  if (action === 'toggle-whole-word') {
    state.showWholeWord = !state.showWholeWord;
    renderPractice();
    return;
  }

  if (action === 'toggle-tip') {
    state.showTip = !state.showTip;
    renderPractice();
    return;
  }

  if (action === 'pick-tile') {
    const build = ensureBuildState(word);
    if (build.status === 'correct') return;
    const uid = btn.dataset.uid;
    const tile = build.tiles.find((t) => t.uid === uid);
    if (!tile) return;

    const emptyIdx = build.slots.findIndex((s) => s === null);
    if (emptyIdx < 0) return;

    build.slots[emptyIdx] = uid;
    build.status = 'idle';

    if (build.slots.every(Boolean)) {
      const assembled = build.slots
        .map((id) => build.tiles.find((t) => t.uid === id)?.texto || '')
        .join('');
      const expected = word.blocos.map((b) => b.texto).join('');
      if (assembled === expected) {
        build.status = 'correct';
        renderPractice();
        sendProgressEvent(word.id, 'correct');
        await audioEngine.play({ text: word.palavra, speed: state.speed, kind: 'word' });
        return;
      } else {
        build.status = 'wrong';
        sendProgressEvent(word.id, 'wrong');
      }
    }

    renderPractice();
    audioEngine.play({
      text: tile.som_guia || tile.texto,
      speed: state.speed,
      kind: 'block',
    });
    return;
  }

  if (action === 'remove-slot') {
    const build = ensureBuildState(word);
    if (build.status === 'correct') return;
    const slotIdx = Number(btn.dataset.slotIndex);
    if (build.slots[slotIdx] !== null) {
      build.slots[slotIdx] = null;
      build.status = 'idle';
      renderPractice();
    }
    return;
  }

  if (action === 'reset-build') {
    const build = ensureBuildState(word);
    build.slots = new Array(word.blocos.length).fill(null);
    build.status = 'idle';
    renderPractice();
    return;
  }

  if (action === 'play-quiz-target') {
    const quiz = ensureQuizState(word);
    const target = word.blocos[quiz.targetIndex];
    await audioEngine.play({
      text: target.som_guia || target.texto,
      speed: state.speed,
      kind: 'block',
    });
    return;
  }

  if (action === 'answer-quiz') {
    const quiz = ensureQuizState(word);
    if (quiz.solved) return;
    const chosenText = btn.dataset.texto;
    const option = quiz.options.find((o) => o.texto === chosenText);
    if (!option) return;

    if (option.isCorrect) {
      quiz.solved = true;
      renderPractice();
      sendProgressEvent(word.id, 'correct');
      await audioEngine.play({ text: word.palavra, speed: state.speed, kind: 'word' });
    } else {
      quiz.wrongAttempts.add(chosenText);
      renderPractice();
      sendProgressEvent(word.id, 'wrong');
      await audioEngine.play({
        text: option.som_guia || option.texto,
        speed: state.speed,
        kind: 'block',
      });
    }
    return;
  }

  if (action === 'go-next') goToNextWord();
});

/* ==================== SEÇÃO 3: MEUS TEXTOS (LEITURA GUIADA) ==================== */
function getActiveMaterial() {
  return state.materials.find((m) => m.id === state.activeMaterialId) || null;
}

function tokenizeSentence(text) {
  // Separa palavras com letras acentuadas de pontuação/espaços
  return String(text || '').match(/[A-Za-zÀ-ÖØ-öø-ÿ]+|[^\sA-Za-zÀ-ÖØ-öø-ÿ]+/g) || [];
}

async function analyzeActiveChunk() {
  const mat = getActiveMaterial();
  if (!mat) return;
  state.analyzingChunk = true;
  renderReading();

  try {
    const res = await fetch(`/api/materials/${encodeURIComponent(mat.id)}/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chunkIndex: state.activeChunkIndex }),
    });
    const data = await res.json();
    if (res.ok && data.wordsMap) {
      state.chunkWordsMap = { ...state.chunkWordsMap, ...data.wordsMap };
      if (data.aiUnavailable && data.missingCount > 0) {
        showToast('Palavras novas aguardam chave OpenAI para divisão silábica automática.');
      }
    }
  } catch {
    showToast('Erro ao analisar sílabas deste trecho.');
  } finally {
    state.analyzingChunk = false;
    renderReading();
  }
}

function renderReading() {
  const mat = getActiveMaterial();

  if (!mat) {
    const listHtml =
      state.materials.length > 0
        ? state.materials
            .map((m) => {
              const doneCount = m.chunks.filter((c) => c.done).length;
              const pct = m.chunks.length
                ? Math.round((doneCount / m.chunks.length) * 100)
                : 0;
              return `
                <div class="material-card">
                  <div class="material-card-top">
                    <div>
                      <h3 class="material-title">${escapeHtml(m.title)}</h3>
                      <div class="material-meta">
                        ${m.sourceType.toUpperCase()} · ${doneCount}/${m.chunks.length} trechos lidos (${pct}%)
                      </div>
                    </div>
                    <button type="button" class="mini-chip" data-read-action="delete-material" data-id="${m.id}">
                      Excluir
                    </button>
                  </div>
                  <div class="progress-track">
                    <div class="progress-fill" style="width: ${pct}%"></div>
                  </div>
                  <button type="button" class="action-btn action-btn-primary" data-read-action="open-material" data-id="${m.id}">
                    ${doneCount > 0 && doneCount < m.chunks.length ? 'Continuar leitura' : 'Abrir leitura guiada'}
                  </button>
                </div>
              `;
            })
            .join('')
        : `
          <div class="practice-card">
            <div class="empty-state">
              Nenhum texto enviado ainda.<br/>
              Suba um <strong>PDF</strong>, <strong>Word (.docx)</strong> ou cole um <strong>texto da escola</strong> para acompanhar frase por frase com divisão silábica e áudio.
            </div>
          </div>
        `;

    els.readingContainer.innerHTML = `
      <button type="button" class="primary-action-btn" data-read-action="open-upload">
        + Enviar PDF, DOCX ou colar texto
      </button>
      ${listHtml}
    `;
    return;
  }

  // Modo leitor de um material específico
  const chunk = mat.chunks[state.activeChunkIndex] || mat.chunks[0];
  const doneCount = mat.chunks.filter((c) => c.done).length;
  const pct = Math.round(((state.activeChunkIndex + 1) / Math.max(1, mat.chunks.length)) * 100);

  const tokens = tokenizeSentence(chunk.text);
  const sentenceHtml = tokens
    .map((tok) => {
      const isWord = /[A-Za-zÀ-ÖØ-öø-ÿ]/.test(tok);
      if (!isWord) {
        return `<span class="punct-token">${escapeHtml(tok)}</span>`;
      }
      const key = normalizeWordKey(tok);
      const hasBlocks = Boolean(state.chunkWordsMap[key]);
      const isSelected = state.selectedReadingWord === key;
      return `
        <button
          type="button"
          class="word-token ${hasBlocks ? 'has-blocks' : ''} ${isSelected ? 'is-selected' : ''}"
          data-read-action="select-word"
          data-word="${escapeHtml(key)}"
          data-display="${escapeHtml(tok)}"
        >${escapeHtml(tok)}</button>
      `;
    })
    .join('');

  // Painel de inspeção da palavra tocada
  let inspectorHtml = '';
  if (state.selectedReadingWord) {
    const analyzed = state.chunkWordsMap[state.selectedReadingWord];
    if (analyzed && Array.isArray(analyzed.blocos)) {
      const blocksHtml = analyzed.blocos
        .map((bloco, i) => {
          const label = TYPE_LABELS[bloco.tipo] || 'Bloco';
          const playingCls = state.readingPlayingBlockIndex === i ? 'is-playing' : '';
          return `
            <button
              type="button"
              class="syllable-block type-${bloco.tipo} ${playingCls}"
              data-read-action="play-reading-block"
              data-index="${i}"
            >
              <span class="block-text">${escapeHtml(bloco.texto)}</span>
              ${createDotsHtml(bloco.qtd_letras)}
              <span class="block-meta">${bloco.qtd_letras} letras · ${label}</span>
            </button>
          `;
        })
        .join('');

      inspectorHtml = `
        <div class="word-inspector">
          <div class="word-inspector-top">
            <h4 class="word-inspector-title">Blocos de "${escapeHtml(analyzed.palavra)}"</h4>
            <button type="button" class="mini-chip" data-read-action="save-reading-word">
              + Salvar na Trilha
            </button>
          </div>
          <div class="blocks-stage">${blocksHtml}</div>
          <div class="actions-grid">
            <button type="button" class="action-btn action-btn-primary" data-read-action="play-reading-seq">
              Passo a passo
            </button>
            <button type="button" class="action-btn" data-read-action="play-reading-word">
              Ouvir palavra
            </button>
          </div>
          ${analyzed.dica ? `<div class="tip-box">${escapeHtml(analyzed.dica)}</div>` : ''}
        </div>
      `;
    } else {
      inspectorHtml = `
        <div class="word-inspector">
          <div class="word-inspector-top">
            <h4 class="word-inspector-title">Palavra: "${escapeHtml(state.selectedReadingWord)}"</h4>
            <button type="button" class="mini-chip" data-read-action="play-reading-word">
              Ouvir
            </button>
          </div>
          <p class="instruction-line">
            ${
              state.analyzingChunk
                ? 'Dividindo sílabas com OpenAI...'
                : state.openaiConfigured
                  ? 'Toque em "Dividir sílabas" para analisar os blocos desta frase.'
                  : 'Configure a chave da OpenAI no .env para dividir automaticamente palavras novas em blocos.'
            }
          </p>
        </div>
      `;
    }
  }

  els.readingContainer.innerHTML = `
    <div class="scope-banner">
      <span>${escapeHtml(mat.title)}</span>
      <button type="button" class="mini-chip" data-read-action="back-list">← Biblioteca</button>
    </div>

    <div class="progress-strip">
      <div class="progress-meta">
        <span>Trecho ${state.activeChunkIndex + 1} de ${mat.chunks.length}</span>
        <span>${doneCount} concluído${doneCount === 1 ? '' : 's'}</span>
      </div>
      <div class="progress-track">
        <div class="progress-fill" style="width: ${pct}%"></div>
      </div>
    </div>

    <div class="reader-card">
      <div class="card-header">
        <span class="badge">${chunk.done ? 'Trecho lido' : 'Em leitura'}</span>
        <button type="button" class="mini-chip" data-read-action="analyze-chunk" ${state.analyzingChunk ? 'disabled' : ''}>
          ${state.analyzingChunk ? 'Analisando...' : 'Dividir sílabas'}
        </button>
      </div>

      <p class="instruction-line">Toque em qualquer palavra para ouvir e ver a divisão em blocos.</p>

      <div class="reader-sentence">${sentenceHtml}</div>

      <div class="actions-grid">
        <button type="button" class="action-btn action-btn-primary" data-read-action="play-chunk">
          Ouvir trecho
        </button>
        <button type="button" class="action-btn ${chunk.done ? '' : 'action-btn-success'}" data-read-action="mark-chunk-done">
          ${chunk.done ? '✓ Já lido' : 'Marcar lido (+15 XP)'}
        </button>
      </div>

      ${inspectorHtml}
    </div>

    <div class="bottom-nav">
      <button type="button" class="nav-btn" data-read-action="prev-chunk" ${state.activeChunkIndex === 0 ? 'disabled' : ''}>
        ← Anterior
      </button>
      <span class="badge" style="align-self:center;">${state.activeChunkIndex + 1}/${mat.chunks.length}</span>
      <button type="button" class="nav-btn nav-btn-primary" data-read-action="next-chunk" ${state.activeChunkIndex >= mat.chunks.length - 1 ? 'disabled' : ''}>
        Próximo →
      </button>
    </div>
  `;
}

els.readingContainer.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-read-action]');
  if (!btn) return;
  const action = btn.dataset.readAction;

  if (action === 'open-upload') {
    els.uploadModal.hidden = false;
    return;
  }

  if (action === 'open-material') {
    const mat = state.materials.find((m) => m.id === btn.dataset.id);
    if (!mat) return;
    state.activeMaterialId = mat.id;
    state.activeChunkIndex = mat.currentChunkIndex || 0;
    state.selectedReadingWord = null;
    renderReading();
    await analyzeActiveChunk();
    return;
  }

  if (action === 'delete-material') {
    const id = btn.dataset.id;
    const res = await fetch(`/api/materials/${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (res.ok) {
      state.materials = state.materials.filter((m) => m.id !== id);
      if (state.activeMaterialId === id) state.activeMaterialId = null;
      renderReading();
      showToast('Material removido.');
    }
    return;
  }

  if (action === 'back-list') {
    audioEngine.stop();
    state.activeMaterialId = null;
    state.selectedReadingWord = null;
    renderReading();
    return;
  }

  const mat = getActiveMaterial();
  if (!mat) return;
  const chunk = mat.chunks[state.activeChunkIndex];

  if (action === 'analyze-chunk') {
    await analyzeActiveChunk();
    return;
  }

  if (action === 'play-chunk' && chunk) {
    await audioEngine.play({ text: chunk.text, speed: state.speed, kind: 'sentence' });
    return;
  }

  if (action === 'select-word') {
    const wordKey = btn.dataset.word;
    state.selectedReadingWord = wordKey;
    state.readingPlayingBlockIndex = -1;
    renderReading();
    await audioEngine.play({ text: wordKey, speed: state.speed, kind: 'word' });
    return;
  }

  if (action === 'play-reading-word' && state.selectedReadingWord) {
    await audioEngine.play({
      text: state.selectedReadingWord,
      speed: state.speed,
      kind: 'word',
    });
    return;
  }

  if (action === 'play-reading-block' && state.selectedReadingWord) {
    const analyzed = state.chunkWordsMap[state.selectedReadingWord];
    const idx = Number(btn.dataset.index);
    const bloco = analyzed?.blocos?.[idx];
    if (!bloco) return;
    state.readingPlayingBlockIndex = idx;
    renderReading();
    await audioEngine.play({
      text: bloco.som_guia || bloco.texto,
      speed: state.speed,
      kind: 'block',
    });
    if (state.readingPlayingBlockIndex === idx) {
      state.readingPlayingBlockIndex = -1;
      renderReading();
    }
    return;
  }

  if (action === 'play-reading-seq' && state.selectedReadingWord) {
    const analyzed = state.chunkWordsMap[state.selectedReadingWord];
    if (!analyzed) return;
    await audioEngine.playSequence(analyzed, state.speed, (idx) => {
      state.readingPlayingBlockIndex = idx;
      renderReading();
    });
    return;
  }

  if (action === 'save-reading-word' && state.selectedReadingWord) {
    const analyzed = state.chunkWordsMap[state.selectedReadingWord];
    if (!analyzed) return;
    const res = await fetch('/api/words/from-reading', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(analyzed),
    });
    const data = await res.json();
    if (res.ok && data.added?.length > 0) {
      state.allWords.push(...data.added);
      showToast(`"${analyzed.palavra}" salva na sua Trilha de treino!`);
      refreshCareer();
    } else {
      showToast('Esta palavra já está na sua Trilha.');
    }
    return;
  }

  if (action === 'mark-chunk-done' && chunk) {
    const res = await fetch(`/api/materials/${encodeURIComponent(mat.id)}/progress`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chunkIndex: state.activeChunkIndex, done: true }),
    });
    const data = await res.json();
    if (res.ok && data.material) {
      const idx = state.materials.findIndex((m) => m.id === mat.id);
      if (idx >= 0) state.materials[idx] = data.material;
      if (data.career) {
        state.career = data.career;
        updateTopXpUI();
      }
      if (data.xpGained > 0) {
        showToast(`Trecho concluído! +${data.xpGained} XP`);
      }
      if (state.activeChunkIndex < data.material.chunks.length - 1) {
        state.activeChunkIndex += 1;
        state.selectedReadingWord = null;
        renderReading();
        await analyzeActiveChunk();
      } else {
        renderReading();
      }
    }
    return;
  }

  if (action === 'prev-chunk' && state.activeChunkIndex > 0) {
    audioEngine.stop();
    state.activeChunkIndex -= 1;
    state.selectedReadingWord = null;
    renderReading();
    await analyzeActiveChunk();
    return;
  }

  if (action === 'next-chunk' && state.activeChunkIndex < mat.chunks.length - 1) {
    audioEngine.stop();
    state.activeChunkIndex += 1;
    state.selectedReadingWord = null;
    renderReading();
    await analyzeActiveChunk();
  }
});

/* ==================== UPLOAD DE MATERIAL (PDF / DOCX / TXT / TEXTO) ==================== */
function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || '');
      const base64 = result.includes(',') ? result.split(',')[1] : result;
      resolve(base64);
    };
    reader.onerror = () => reject(new Error('Não foi possível ler o arquivo selecionado.'));
    reader.readAsDataURL(file);
  });
}

els.closeUploadBtn.addEventListener('click', () => {
  els.uploadModal.hidden = true;
});

els.uploadModal.addEventListener('click', (e) => {
  if (e.target === els.uploadModal) els.uploadModal.hidden = true;
});

els.uploadForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const title = els.materialTitleInput.value.trim();
  const file = els.materialFileInput.files?.[0];
  const text = els.materialTextInput.value.trim();

  if (!file && !text) {
    showToast('Selecione um arquivo (.pdf, .docx, .txt) ou cole um texto.');
    return;
  }

  els.submitUploadBtn.disabled = true;
  els.submitUploadBtn.textContent = 'Processando conteúdo...';

  try {
    let payload;
    if (file) {
      const fileBase64 = await fileToBase64(file);
      payload = { title, fileName: file.name, fileBase64 };
    } else {
      payload = { title, text };
    }

    const res = await fetch('/api/materials', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Erro ao enviar conteúdo.');

    state.materials.unshift(data.material);
    state.activeMaterialId = data.material.id;
    state.activeChunkIndex = 0;
    state.selectedReadingWord = null;

    els.uploadForm.reset();
    els.uploadModal.hidden = true;
    showToast(`"${data.material.title}" pronto com ${data.material.chunks.length} trecho(s)!`);
    renderReading();
    await analyzeActiveChunk();
  } catch (err) {
    showToast(err.message || 'Erro ao processar arquivo.');
  } finally {
    els.submitUploadBtn.disabled = false;
    els.submitUploadBtn.textContent = 'Criar leitura guiada';
  }
});

/* ==================== CONTROLES GERAIS ==================== */
function goToNextWord() {
  if (!state.filteredWords.length) return;
  state.currentIndex = (state.currentIndex + 1) % state.filteredWords.length;
  resetModeSubstates();
  renderPractice();
}

function goToPrevWord() {
  if (!state.filteredWords.length) return;
  state.currentIndex =
    (state.currentIndex - 1 + state.filteredWords.length) % state.filteredWords.length;
  resetModeSubstates();
  renderPractice();
}

document.querySelectorAll('.primary-tab').forEach((tab) => {
  tab.addEventListener('click', () => switchSection(tab.dataset.section));
});

document.querySelectorAll('.mode-tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    const mode = tab.dataset.mode;
    if (mode === state.mode) return;
    state.mode = mode;
    document.querySelectorAll('.mode-tab').forEach((t) => {
      const active = t.dataset.mode === mode;
      t.classList.toggle('is-active', active);
      t.setAttribute('aria-selected', String(active));
    });
    resetModeSubstates();
    renderPractice();
  });
});

els.clearScopeBtn.addEventListener('click', () => {
  state.scope = null;
  els.contextHint.textContent = 'Treino por blocos silábicos';
  applyFilters();
});

els.categoryFilters.addEventListener('click', (e) => {
  const chip = e.target.closest('.filter-chip');
  if (!chip) return;
  state.category = chip.dataset.category;
  els.categoryFilters.querySelectorAll('.filter-chip').forEach((c) => {
    c.classList.toggle('is-active', c === chip);
  });
  applyFilters();
});

els.levelFilters.addEventListener('click', (e) => {
  const chip = e.target.closest('.mini-chip');
  if (!chip) return;
  state.level = chip.dataset.level;
  els.levelFilters.querySelectorAll('.mini-chip').forEach((c) => {
    c.classList.toggle('is-active', c === chip);
  });
  applyFilters();
});

els.speedToggleBtn.addEventListener('click', () => {
  state.speed = state.speed === 'normal' ? 'slow' : 'normal';
  const isSlow = state.speed === 'slow';
  els.speedToggleBtn.setAttribute('aria-pressed', String(isSlow));
  els.speedLabel.textContent = isSlow ? 'Devagar 0.75x' : 'Normal 1x';
});

els.prevWordBtn.addEventListener('click', goToPrevWord);
els.nextWordBtn.addEventListener('click', goToNextWord);
els.shuffleBtn.addEventListener('click', () => {
  if (state.filteredWords.length < 2) return;
  state.filteredWords = shuffleArray(state.filteredWords);
  state.currentIndex = 0;
  resetModeSubstates();
  renderPractice();
  showToast('Ordem das palavras embaralhada.');
});

function initTheme() {
  const saved = localStorage.getItem('decodifica_theme') || 'dark';
  document.documentElement.setAttribute('data-theme', saved);
}

els.themeToggleBtn.addEventListener('click', () => {
  const current = document.documentElement.getAttribute('data-theme') || 'dark';
  const next = current === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  localStorage.setItem('decodifica_theme', next);
});

/* ==================== MODAL GERADOR (OPENAI) ==================== */
const generatorSelections = { focus: 'digrafos', pattern: '', level: 2, count: 3 };

function bindPillGroup(containerId, key, parseFn = (v) => v) {
  const container = document.getElementById(containerId);
  if (!container) return;
  container.addEventListener('click', (e) => {
    const pill = e.target.closest('.select-pill');
    if (!pill) return;
    generatorSelections[key] = parseFn(pill.dataset.value);
    container.querySelectorAll('.select-pill').forEach((p) => {
      p.classList.toggle('is-active', p === pill);
    });
  });
}

bindPillGroup('genFocusOptions', 'focus');
bindPillGroup('genPatternOptions', 'pattern');
bindPillGroup('genLevelOptions', 'level', Number);
bindPillGroup('genCountOptions', 'count', Number);

els.openGeneratorBtn.addEventListener('click', () => {
  els.generatorOfflineNotice.hidden = state.openaiConfigured;
  els.submitGeneratorBtn.disabled = !state.openaiConfigured;
  els.generatorModal.hidden = false;
});

els.closeGeneratorBtn.addEventListener('click', () => {
  els.generatorModal.hidden = true;
});

els.generatorModal.addEventListener('click', (e) => {
  if (e.target === els.generatorModal) els.generatorModal.hidden = true;
});

els.generatorForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!state.openaiConfigured) return;

  els.submitGeneratorBtn.disabled = true;
  els.submitGeneratorBtn.textContent = 'Gerando palavras...';

  try {
    const res = await fetch('/api/words/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(generatorSelections),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Não foi possível gerar palavras.');

    if (data.added?.length > 0) {
      state.allWords.push(...data.added);
      state.scope = null;
      state.category = 'all';
      state.level = 'all';
      applyFilters({ keepWordId: data.added[0].id });
      els.generatorModal.hidden = true;
      await refreshCareer();
      switchSection('practice');
      showToast(`${data.added.length} nova(s) palavra(s) adicionada(s)!`);
    } else {
      showToast('Nenhuma palavra nova foi aceita. Tente outro padrão.');
    }
  } catch (err) {
    showToast(err.message || 'Erro ao gerar palavras.');
  } finally {
    els.submitGeneratorBtn.disabled = !state.openaiConfigured;
    els.submitGeneratorBtn.textContent = 'Gerar e salvar no banco local';
  }
});

async function refreshCareer() {
  try {
    const res = await fetch('/api/progress');
    const data = await res.json();
    if (res.ok) {
      state.progress = data.progress;
      state.career = data.career;
      updateTopXpUI();
      if (state.section === 'career') renderCareer();
    }
  } catch {
    // Ignora
  }
}

/* ==================== BOOTSTRAP ==================== */
async function bootstrap() {
  initTheme();
  try {
    const [healthRes, wordsRes, progressRes, materialsRes] = await Promise.all([
      fetch('/api/health'),
      fetch('/api/words'),
      fetch('/api/progress'),
      fetch('/api/materials'),
    ]);

    const health = await healthRes.json();
    const wordsData = await wordsRes.json();
    const progressData = await progressRes.json();
    const materialsData = await materialsRes.json();

    state.openaiConfigured = Boolean(health.openaiConfigured);
    audioEngine.setOpenAIEnabled(state.openaiConfigured);

    els.audioStatusBadge.textContent = state.openaiConfigured
      ? `Voz OpenAI pt-BR · ${health.cachedAudioCount || 0} em cache`
      : 'Modo local · Voz do navegador';

    state.allWords = Array.isArray(wordsData.words) ? wordsData.words : [];
    state.progress = progressData.progress || { words: {} };
    state.career = progressData.career || null;
    state.materials = Array.isArray(materialsData.materials) ? materialsData.materials : [];

    updateTopXpUI();
    applyFilters();
    renderCareer();
  } catch {
    els.audioStatusBadge.textContent = 'Erro ao conectar';
    els.careerContainer.innerHTML = `
      <div class="empty-state">
        Não foi possível conectar ao servidor.<br/>
        Verifique se <code>npm start</code> está rodando.
      </div>
    `;
  }
}

bootstrap();
