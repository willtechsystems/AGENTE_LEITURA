# Decodifica — Apoio à Leitura por Blocos Silábicos

Web App educativo **mobile-first** criado para apoiar adolescentes (13+) em decodificação de leitura, separação silábica e consciência fonológica — com foco em **blocos sonoros de 2 e 3 letras**, **trilha de carreira com memória espaçada** e **leitura guiada de PDF, Word (.docx) e textos puros**.

## Recursos principais
- **Trilha & Memória (estilo carreira, visual maduro)**:
  - 5 unidades progressivas (Base de 2 letras → Dígrafos NH/LH/CH → Dígrafos RR/SS/QU → Encontros Consonantais → Combinações e Desafio).
  - **Memória por palavra (Repetição Espaçada - SRS)**: acompanha quais palavras são *Novas*, *Em aprendizado*, *Consolidando* ou *Dominadas*, agendando revisões automáticas, XP, meta diária e sequência de dias.
- **Treino por Blocos (sem teclado nativo)**:
  - **Explorar**: toque em cada bloco para ouvir o som junto, ouça passo a passo com destaque visual ou ouça a palavra inteira.
  - **Montar**: monte a palavra tocando nos blocos embaralhados (com distratores fonológicos como `TRA` vs `TA`).
  - **Qual é o bloco?**: identifique o bloco pelo som com comparação auditiva.
- **Meus Textos (Acompanhamento de Leitura)**:
  - Envie **PDF**, **Word (`.docx`)**, **`.txt`** ou cole texto puro.
  - O app divide o conteúdo em trechos curtos confortáveis para celular, lê o trecho em voz alta, divide cada palavra em blocos silábicos via OpenAI (com cache persistente em disco) e permite salvar palavras difíceis direto na Trilha de treino.
- **OpenAI API + Cache em disco**:
  - Voz neural em `pt-BR` cacheada em `cache/audio/` (com suporte a HTTP `Range` para iOS Safari e Android Chrome).
  - Funciona também sem chave OpenAI, usando o dataset local e fallback de voz `pt-BR` do navegador.

## Como rodar localmente
```bash
npm install
cp .env.example .env   # opcional: adicione OPENAI_API_KEY
npm start
```

## Publicar no GitHub + Deploy na nuvem (acesso em qualquer celular)
1. Suba este repositório para o GitHub (o `.gitignore` já protege o `.env` para que sua chave da OpenAI nunca vá para o GitHub).
2. No **Render.com** (ou **Railway.app**):
   - Conecte o repositório do GitHub (o arquivo `render.yaml` já vem configurado).
   - Adicione a variável de ambiente `OPENAI_API_KEY` no painel da plataforma.
   - Em poucos minutos você terá um link `https://...` fixo para abrir em qualquer celular (4G/5G ou Wi-Fi) e adicionar à tela inicial.
