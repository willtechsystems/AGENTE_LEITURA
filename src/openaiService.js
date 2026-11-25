import { config, isOpenAIConfigured } from './config.js';

const OPENAI_BASE_URL = 'https://api.openai.com/v1';

/**
 * Gera áudio MP3 em pt-BR via OpenAI Audio Speech API.
 * kind: 'block' | 'word' | 'sentence'
 */
export async function synthesizeSpeech({ text, speed = 'normal', kind = 'block' }) {
  if (!isOpenAIConfigured()) {
    const err = new Error('OPENAI_API_KEY não configurada.');
    err.code = 'OPENAI_NOT_CONFIGURED';
    throw err;
  }

  const rawText = String(text || '').trim();
  const cleanText = kind === 'sentence' ? rawText : rawText.toLocaleLowerCase('pt-BR');
  if (!cleanText) {
    const err = new Error('Texto vazio para síntese de voz.');
    err.code = 'INVALID_INPUT';
    throw err;
  }

  const isSlow = speed === 'slow';
  const numericSpeed = isSlow ? 0.78 : 1.0;

  const body = {
    model: config.ttsModel,
    voice: config.ttsVoice,
    input: kind === 'block' ? `${cleanText}.` : cleanText,
    response_format: 'mp3',
    speed: numericSpeed,
  };

  if (config.ttsModel.includes('gpt-4o')) {
    if (kind === 'block') {
      body.instructions =
        'Fale em português do Brasil (pt-BR). Pronuncie APENAS esta sílaba isolada como um único bloco sonoro natural e claro. NÃO soletre letra por letra, NÃO adicione explicações e mantenha dicção nítida.';
    } else if (kind === 'sentence') {
      body.instructions =
        'Fale em português do Brasil (pt-BR). Leia esta frase de forma clara, pausada e natural, com tom respeitoso e adequado para um adolescente acompanhando a leitura. Sem adicionar comentários.';
    } else {
      body.instructions =
        'Fale em português do Brasil (pt-BR). Pronuncie APENAS esta palavra com dicção clara, natural e respeitosa, sem adicionar comentários.';
    }
  }

  const response = await fetch(`${OPENAI_BASE_URL}/audio/speech`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.openaiApiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    const err = new Error(`Falha na OpenAI TTS (${response.status}): ${errText.slice(0, 200)}`);
    err.code = 'OPENAI_TTS_ERROR';
    err.status = response.status;
    throw err;
  }

  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

/**
 * Gera novas palavras estruturadas em blocos silábicos via OpenAI Chat Completions (JSON Schema).
 */
export async function generateStructuredWords({
  focus = 'digrafos',
  level = 2,
  count = 4,
  pattern = '',
  existingWords = [],
}) {
  if (!isOpenAIConfigured()) {
    const err = new Error('OPENAI_API_KEY não configurada.');
    err.code = 'OPENAI_NOT_CONFIGURED';
    throw err;
  }

  const safeCount = Math.min(Math.max(Number(count) || 4, 1), 8);
  const safeLevel = [1, 2, 3].includes(Number(level)) ? Number(level) : 2;

  const focusMap = {
    silabas_simples: 'sílabas simples (consoante + vogal de 2 letras)',
    digrafos: 'dígrafos do português (NH, LH, CH, RR, SS, QU)',
    encontros_consonantais: 'encontros consonantais (TR, PR, BL, CR, FR, GR, PL, BR, DR, FL, CL)',
    mistas: 'combinação de sílabas simples com dígrafos ou encontros consonantais',
  };

  const focusDescription = focusMap[focus] || focusMap.digrafos;
  const patternNote = pattern ? `Dê prioridade especial ao padrão: "${pattern}".` : '';
  const excludeSample = existingWords.slice(-80).join(', ');

  const systemPrompt = [
    'Você é um especialista em alfabetização, consciência fonológica e fonoaudiologia em Português do Brasil (pt-BR) para adolescentes de 13 anos.',
    'Crie palavras reais, cotidianas e adequadas à idade de um adolescente (evite vocabulário infantilizado).',
    'REGRA CRÍTICA: A concatenação exata de `blocos[].texto` (ignorando maiúsculas/minúsculas) DEVE formar exatamente `palavra`.',
    'Para blocos com RR ou SS (ex.: carro -> CA + RRO, passo -> PA + SSO), mantenha o dígrafo unido na sílaba para evidenciar a unidade sonora de 3 letras.',
    'Para dígrafos NH, LH, CH, QU (ex.: caminho -> CA + MI + NHO, queda -> QUE + DA), mantenha as 3 letras juntas no mesmo bloco com tipo "digrafo".',
    'Para encontros consonantais inseparáveis (ex.: trabalho -> TRA + BA + LHO, bloco -> BLO + CO), mantenha as 3 letras juntas com tipo "encontro_consonantal".',
    '`qtd_letras` deve ser exatamente o número de caracteres de `texto`.',
    '`som_guia` deve ser a grafia em minúsculas otimizada para um TTS brasileiro pronunciar a sílaba sem soletrar (ex.: "cha" -> "xá", "tra" -> "tra", "lho" -> "lho").',
  ].join(' ');

  const userPrompt = [
    `Gere exatamente ${safeCount} palavras novas em português do Brasil de nível ${safeLevel} (1=básico, 2=intermediário, 3=desafio).`,
    `Foco principal: ${focusDescription}. ${patternNote}`,
    `Categoria sugerida: "${focus in focusMap ? focus : 'mistas'}".`,
    excludeSample ? `NÃO repita nenhuma destas palavras já existentes: ${excludeSample}.` : '',
  ]
    .filter(Boolean)
    .join('\n');

  const schema = {
    name: 'palavras_blocos_silabicos',
    strict: true,
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['palavras'],
      properties: {
        palavras: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['id', 'nivel', 'categoria', 'palavra', 'dica', 'blocos'],
            properties: {
              id: { type: 'string' },
              nivel: { type: 'integer', enum: [1, 2, 3] },
              categoria: {
                type: 'string',
                enum: ['silabas_simples', 'digrafos', 'encontros_consonantais', 'mistas'],
              },
              palavra: { type: 'string' },
              dica: { type: 'string' },
              blocos: {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  required: ['texto', 'tipo', 'qtd_letras', 'som_guia'],
                  properties: {
                    texto: { type: 'string' },
                    tipo: {
                      type: 'string',
                      enum: ['silaba_simples', 'digrafo', 'encontro_consonantal', 'silaba_complexa'],
                    },
                    qtd_letras: { type: 'integer' },
                    som_guia: { type: 'string' },
                  },
                },
              },
            },
          },
        },
      },
    },
  };

  const response = await fetch(`${OPENAI_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.openaiApiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: config.chatModel,
      temperature: 0.7,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      response_format: {
        type: 'json_schema',
        json_schema: schema,
      },
    }),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    const err = new Error(`Falha na OpenAI Chat (${response.status}): ${errText.slice(0, 200)}`);
    err.code = 'OPENAI_CHAT_ERROR';
    err.status = response.status;
    throw err;
  }

  const data = await response.json();
  const content = data?.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error('Resposta vazia da OpenAI ao gerar palavras.');
  }

  const parsed = JSON.parse(content);
  return Array.isArray(parsed.palavras) ? parsed.palavras : [];
}

/**
 * Analisa uma lista de palavras vindas de um texto/PDF/DOCX e retorna a divisão em blocos sonoros estruturados.
 */
export async function analyzeWordsIntoBlocks(wordsList = []) {
  if (!isOpenAIConfigured()) {
    const err = new Error('OPENAI_API_KEY não configurada.');
    err.code = 'OPENAI_NOT_CONFIGURED';
    throw err;
  }

  const cleanList = wordsList
    .map((w) => String(w || '').trim().toLocaleLowerCase('pt-BR'))
    .filter((w) => w.length >= 2)
    .slice(0, 24);

  if (cleanList.length === 0) return [];

  const systemPrompt = [
    'Você é um especialista em fonoaudiologia e decodificação silábica em Português do Brasil (pt-BR) para adolescentes de 13 anos.',
    'Para cada palavra fornecida, divida-a em blocos sonoros explícitos.',
    'REGRA CRÍTICA: A concatenação exata de `blocos[].texto` (ignorando maiúsculas/minúsculas) DEVE formar exatamente `palavra` (preservando acentos e cedilha).',
    'Classifique cada bloco como: "silaba_simples" (1-2 letras regulares), "digrafo" (NH, LH, CH, RR, SS, QU, GU), "encontro_consonantal" (TR, PR, BL, CR, FR, GR, PL, BR, DR, FL, CL, VR, etc.) ou "silaba_complexa" (sílabas travadas como AR, ES, AN, ON, ÃO, etc.).',
    'Para RR e SS (ex.: carro -> CA + RRO), mantenha RR/SS unidos no mesmo bloco para evidenciar o som único.',
    '`qtd_letras` deve ser exatamente o número de caracteres de `texto`.',
    '`som_guia` deve ser em minúsculas otimizado para TTS brasileiro pronunciar a sílaba sem soletrar.',
    '`dica` deve ser curta, direta e madura (1 frase) destacando a junção principal da palavra.',
  ].join(' ');

  const schema = {
    name: 'analise_blocos_leitura',
    strict: true,
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['itens'],
      properties: {
        itens: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['palavra', 'dica', 'blocos'],
            properties: {
              palavra: { type: 'string' },
              dica: { type: 'string' },
              blocos: {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  required: ['texto', 'tipo', 'qtd_letras', 'som_guia'],
                  properties: {
                    texto: { type: 'string' },
                    tipo: {
                      type: 'string',
                      enum: ['silaba_simples', 'digrafo', 'encontro_consonantal', 'silaba_complexa'],
                    },
                    qtd_letras: { type: 'integer' },
                    som_guia: { type: 'string' },
                  },
                },
              },
            },
          },
        },
      },
    },
  };

  const response = await fetch(`${OPENAI_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.openaiApiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: config.chatModel,
      temperature: 0.2,
      messages: [
        { role: 'system', content: systemPrompt },
        {
          role: 'user',
          content: `Analise exatamente estas palavras em pt-BR: ${JSON.stringify(cleanList)}`,
        },
      ],
      response_format: {
        type: 'json_schema',
        json_schema: schema,
      },
    }),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    const err = new Error(`Falha na OpenAI ao analisar texto (${response.status}): ${errText.slice(0, 200)}`);
    err.code = 'OPENAI_ANALYZE_ERROR';
    throw err;
  }

  const data = await response.json();
  const content = data?.choices?.[0]?.message?.content;
  if (!content) return [];
  const parsed = JSON.parse(content);
  return Array.isArray(parsed.itens) ? parsed.itens : [];
}
