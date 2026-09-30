# restyle

Ferramenta local de conversão de estilo para imagens. Lê um documento de direção de arte, monta o prompt a partir dele e re-renderiza uma imagem existente no estilo escolhido.

Roda em `127.0.0.1:3488`. Zero dependências — só Node (>= 20) e a biblioteca padrão.

```bash
npm start      # http://127.0.0.1:3488
npm test       # 53 testes
```

## Só imagem

O pipeline faz **uma** chamada de rede, e ela é de imagem:

```
art-direction.yaml ─┐
  identity_universe  │
  styles[A|B|C]      ├─→ montagem do prompt ─→ provider de imagem ─→ PNG
  preservation       │      (lib/providers.mjs)
  negative_by_style  │
imagem original ─────┘
```

Não há chamada de texto em nenhum lugar. A direção de arte vive no `art-direction.yaml`, já em inglês e no formato certo, e vai pro modelo sem tradução no meio.

Isso é uma escolha, não uma limitação. As consequências:

- **Identidade preservada na íntegra.** `identity_universe` chega byte a byte, sempre. Não existe LLM no meio para parafrasear, inventar cor, ou diluir a regra de preservação.
- **Nada é inferido.** O `.md` nunca é interpretado por máquina. Não há provenance a auditar porque não há geração — o card é escrito à mão.
- **Iterar é de graça.** `/api/preview` monta e mostra o prompt sem chamar provider nenhum e sem precisar de chave.

O que se perde é o QA numérico por LLM. No lugar: variantes por imagem e a comparação lado a lado, e você escolhe a olho. Para direção de arte o julgamento final é seu mesmo — e é de graça.

## Providers

| | modelo padrão | custo |
|---|---|---|
| `gemini` | `gemini-3.1-flash-image` | free tier, sem cartão |
| `openai` | `gpt-image-2` | exige billing na Platform |

`gemini` é o default por ser gratuito. Ambos editam imagem (não só geram), que é o que conversão de estilo precisa.

Chaves em `Config`, nunca no card nem no `.md`. `GET /api/settings` devolve só `*Set` e os últimos 6 caracteres.

> A documentação do Google recomenda **no máximo 3 imagens de entrada** nos modelos Flash. Por isso `refs` é limitado e a ordem importa: a **original sempre primeiro**, porque é ela que ancora a composição. Inverter isso faz o modelo reescrever a silhueta em vez de re-renderizá-la.

Para apontar o provider para um servidor local durante testes:

```bash
GEMINI_BASE=http://127.0.0.1:3492 npm start
```

## Os dois arquivos de direção de arte

**`art-direction.md`** — seu documento, humano. Nunca é sobrescrito, nunca é lido por máquina. É a fonte da verdade editorial.

**`art-direction.yaml`** — o card, machine-readable. É o que o pipeline lê. Não gerado por LLM, escrito à mão.

Campos que o `buildPrompt` consome:

| campo | efeito |
|---|---|
| `identity_universe` | primeiro, literal — a assinatura do universo |
| `styles.<id>.name` | rótulo na UI e no nome do arquivo |
| `styles.<id>.traits` | o que muda entre A / B / C |
| `styles.<id>.aspect` | `3:4` ou `16:9` |
| `styles.<id>.clean_distressed` | `0.7` → "30% clean / 70% distressed" |
| `preservation` | regra de não-trocar-o-personagem; nunca some |
| `negative_common` | sempre no fim |
| `negative_by_style.<id>` | só no estilo correspondente |
| `palette_rule` | linguagem cromática compartilhada |
| `small_scale_rule` | omitida no estilo C, que é o splash |
| `roster.<nome>` | accent secundário, se o nome da imagem casar |

`preservation` vem **antes** dos negativos de propósito: o que vem depois não deve conseguir apagar a regra de identidade.

Se `preservation` estiver ausente no card, entra um fallback em vez de prompt sem trava. É a única frase que impede o modelo de redesenhar o personagem em vez de re-renderizá-lo — falhar fechada aqui é intencional.

### Nota sobre texto no estilo C

`negative_by_style.C: []` **não** significa "texto é bem-vindo". O viés padrão dos modelos é não gerar texto, então lista vazia não basta: o `traits` do C pede `visible background text and display typography` explicitamente. Se você criar um estilo que quer texto, peça explicitamente nos traits.

## Fluxo

1. `sourceDir` aponta para a pasta de imagens
2. **Escanear** — lista as imagens; `.json` ao lado sobrescreve o nome do assunto
3. Selecione **estilo**, **provider** e **variantes**
4. **Converter selecionadas**

O card pode ser editado em disco; **Direção de arte → Recarregar do disco** aplica sem reiniciar.

### Idempotência

`work/manifest.json` mapeia `hash(artDirHash + sourceHash + prompt + provider + model + quality + aspect + style)` → saída.

- Já gerado com a mesma direção de arte → **pulado**
- Mudou a direção de arte → regenera
- **forçar re-render** ignora o manifesto

`style` entrou na chave depois de um bug real: sem ele, converter a mesma imagem como A e como C produzia a mesma chave, e o segundo job pulava o primeiro servindo a imagem do estilo errado.

### Variantes

Com `variantes = N` (até 4), cada imagem gera N arquivos, prompt idêntico, saída diferente. Sem QA numérico, gastar cota em alternativas é mais útil do que num score que ninguém pediu.

## API

| rota | o que faz |
|---|---|
| `GET /api/styles` | estilos do card, com aspect, ratio e nº de negativas |
| `POST /api/preview` | monta o prompt. Sem chave, sem rede |
| `GET /api/scan?dir=` | lista imagens |
| `POST /api/render` | cria job (`style`, `provider`, `variants`, `draft`, `force`) |
| `GET /api/job?id=` | progresso |
| `POST /api/job/cancel` | cancela |
| `GET`/`POST /api/settings` | config |
| `POST /api/artdir/reload` | relê o card do disco |
| `GET /api/image?p=` | serve imagem de uma allowlist de raízes |

Erros do cliente são `400`/`403`/`404`, nunca `500`. `draft` usa o modelo barato do provider.

## Segurança

- Escuta só em `127.0.0.1`
- `sourceDir` é **leitura**: nunca escreve na pasta de origem
- `/api/image` só serve de dentro de uma allowlist; traversal dá `403`
- Segredos ficam em `config.json`, que está no `.gitignore`
- `work/` e `config.json` fora do versionamento

## Testes

`npm test` — 53 testes, sem rede e sem chave.

- `prompt.spec.mjs` — montagem: identidade literal, preservation sempre presente e antes dos negativos, negativas por estilo, razão §4, accent do roster, fallback
- `manifest.spec.mjs` — chaves, incluindo a regressão de colisão A/C; parser do card; BOM
- `e2e.spec.mjs` — servidor contra um **mock HTTP** do Gemini: rotas, ordem das inputs, idempotência, colisão de estilo, variantes, 403/400/404, sem segredos no GET

## Estrutura

```
server.mjs              rotas, jobs, config
lib/providers.mjs       montagem do prompt + clientes openai/gemini
lib/render.mjs          guarantees comuns a todo provider
lib/artdir.mjs          lê e hasheia a direção de arte
lib/manifest.mjs        idempotência e histórico
public/                 UI
art-direction.md        seu documento, humano
art-direction.yaml      o card
refs/                   imagens de referência (opcional)
```