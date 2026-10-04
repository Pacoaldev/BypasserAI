<p align="center">
  <img src="assets/logo.png" alt="BypasserAI" width="480" />
</p>

<h1 align="center">BypasserAI</h1>

<p align="center">
  <strong>Humanizador pre-commit para código con “forma de IA”.</strong><br />
  Detección determinista en cada commit — la API solo cuando hace falta.
</p>

<p align="center">
  <a href="https://github.com/Pacoaldev/BypasserAI/actions/workflows/ci.yml"><img src="https://github.com/Pacoaldev/BypasserAI/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/licencia-MIT-blue.svg" alt="Licencia: MIT" /></a>
  <img src="https://img.shields.io/badge/node-%3E%3D18-339933?logo=node.js&logoColor=white" alt="Node >= 18" />
  <a href="https://github.com/Pacoaldev/BypasserAI/issues"><img src="https://img.shields.io/github/issues/Pacoaldev/BypasserAI" alt="Issues" /></a>
</p>

<p align="center">
  <a href="README.md">English</a> ·
  <a href="#inicio-rapido">Inicio rápido</a> ·
  <a href="#como-funciona">Cómo funciona</a> ·
  <a href="#configuracion">Configuración</a> ·
  <a href="#referencia-cli">CLI</a> ·
  <a href="#desarrollo">Desarrollo</a> ·
  <a href="AGENTS.md">AGENTS.md</a> (agentes de código)
</p>

---

## ¿Qué es?

**BypasserAI** es un hook pre-commit de Git y una CLI que:

1. **Puntúa** los archivos en staging buscando patrones típicos de código generado por IA (sin API, determinista).
2. **Reescribe** los que superan tu umbral mediante cualquier API de chat **compatible con OpenAI**, guiada por la [skill humanizer](docs/SKILL.es.md) ([English](docs/SKILL.en.md)).
3. **Vuelve a hacer stage** de las reescrituras correctas para que el commit use la versión humanizada.

Es **agnóstico al lenguaje** (JS/TS, Python, Go, Rust, Java, C#, PHP, Ruby, etc.) y **al proyecto**: lo instalas una vez por repo, apuntas al proveedor y lo olvidas hasta que el toast te avise.

> **Alcance:** Autoría natural en Git y calidad de código — no evasión de detectores académicos de plagio. Ver [Límites](#limites).

---

## Características

| | |
|---|---|
| **Detección gratis** | El scorer heurístico corre en local en cada commit; no gastas tokens en archivos limpios. |
| **Scope inteligente** | Archivos pequeños → archivo completo; grandes → hunks del diff o trozos por declaraciones (`rewriteScope: auto`). |
| **Seguridad primero** | Guardas de truncado, indentación, estructura y sintaxis; restage atómico con rollback `.bak` — ante la duda gana el original. |
| **Reescrituras en paralelo** | Concurrencia configurable entre archivos (`rewriteConcurrency`). |
| **Toasts en Windows** | Notificaciones nativas tras cada commit (BurntToast → WinRT). |
| **Cualquier API OpenAI-compatible** | OpenAI, Groq, OpenRouter, Ollama, LM Studio, proxies locales, etc. |
| **Listo para agentes** | [`AGENTS.md`](AGENTS.md) documenta arquitectura e invariantes para herramientas de IA. |

---

## Inicio rápido

```bash
git clone https://github.com/Pacoaldev/BypasserAI.git
cd BypasserAI
npm install && npm run build && npm link
```

En **tu repo de aplicación** (no dentro de BypasserAI):

```bash
cd /ruta/a/mi-app
bypasser init
export BYPASSER_API_KEY=sk-...          # PowerShell: $env:BYPASSER_API_KEY = "sk-..."
bypasser install
git commit -m "test"                    # el hook corre solo
```

Usa `BYPASSER_VERBOSE=1` si quieres detalle por señal en la salida del hook.

---

## Cómo funciona

```
git commit
    │
    ▼
hook pre-commit  →  bypasser audit --pre-commit
    │
    ▼
archivos en staging (respeta globs ignore y mínimo de líneas cambiadas)
    │
    ▼
detector puntúa el CONTENIDO COMPLETO del archivo (0–1, determinista, sin API)
    │
    ├─ score < umbral ──► pasa sin tocar
    │
    └─ score ≥ umbral ──► reescritura vía API OpenAI-compatible (skill humanizer)
              │
              ▼
         guardas de integridad → restage si OK; original si falla
    │
    ▼
el commit continúa (el hook nunca bloquea por errores de herramienta/API)
```

La detección usa siempre el **archivo staged completo**, así un cambio mínimo en un archivo grande generado por IA sigue contando. El **diff de git** decide la **estrategia** de reescritura (archivo / hunks / chunks), no la puntuación.

---

## Requisitos

- **Node.js 18+**
- Repositorio **Git**
- **Clave API** de un proveedor compatible con OpenAI (recomendado por variable de entorno)

---

## Instalación

### Desde el código fuente (recomendado hoy)

```bash
git clone https://github.com/Pacoaldev/BypasserAI.git
cd BypasserAI
npm install
npm run build
npm link    # deja el comando `bypasser` disponible globalmente
```

> Tras cambiar `src/` en este repo, ejecuta otra vez **`npm run build`**. El hook en todos los proyectos usa `dist/cli.js` de tu copia enlazada — un `dist/` viejo = comportamiento viejo.

### Desde npm (cuando se publique)

```bash
npm install -g bypasser-ai
# o: npx bypasser-ai <comando>
```

---

## Configuración en tu proyecto

Dentro del repo que quieras proteger:

```bash
bypasser init
```

- Crea `.bypasser.json` con valores por defecto razonables.
- **No sobrescribe** una config existente (protege `apiKey` y ajustes manuales). Usa `bypasser init --force` para regenerar.
- Añade a `.gitignore`: `.bypasser.log`, `.bypasser.state.json`, `*.bypasser.tmp`, `*.bak`.

Ejemplo de config (las claves omitidas se rellenan en runtime con `loadConfig()`):

```json
{
  "baseURL": "https://api.openai.com/v1",
  "model": "gpt-4o-mini",
  "threshold": 0.65,
  "maxTokens": 16384,
  "temperature": 0.4,
  "ignore": [],
  "thresholds": [],
  "timeoutMs": 120000,
  "timeoutPer1kLinesMs": 30000,
  "maxTimeoutMs": 600000,
  "maxFileLines": 2000,
  "rewriteConcurrency": 3,
  "rewriteScope": "auto",
  "rewriteFullFileBelowLines": 400,
  "contextLines": 60,
  "maxChunkLines": 450,
  "structuralCheck": true
}
```

```bash
export BYPASSER_API_KEY=sk-...
bypasser install
```

### Excluir repos (pre-commit ajeno)

Si un repo ya tiene su propio flujo pre-commit, **no** instales BypasserAI ahí. Define los nombres de carpeta (basename, minúsculas) antes del install:

```bash
export BYPASSER_HOOK_EXCLUDED_REPOS="mi-repo,monolito-legacy"
bypasser install   # falla dentro de esos directorios
```

Detalle: [AGENTS.md → Hook install exclusions](AGENTS.md#hook-install-exclusions-opt-out-mechanism). `bypasser uninstall` sigue quitando nuestro hook si se instaló por error.

---

## Qué pasa al hacer commit

| Canal | Qué ves |
|-------|---------|
| **Salida del hook** | Puntuación compacta por archivo + humanized / ok / skipped / failed |
| **`.bypasser.log`** | Historial con marcas de tiempo y señales disparadas (ideal dejarlo abierto en una pestaña) |
| **Toast Windows** | Clean / Humanized / Rewrite failed (opcional; solo Windows) |

Ejemplo de log:

```
── 2026-09-28 14:32:11 ─────────────────────────────────────
  src/utils.ts: 72% [███████░░░] ✓ humanized & re-staged
    ↳ [naming] Over-descriptive variable names
  src/index.ts: 31% [███░░░░░░░] ✓ ok
  → 1 file(s) humanized and re-staged
```

Auditoría manual con detalle:

```bash
bypasser audit --verbose
# o: BYPASSER_VERBOSE=1 git commit
```

---

## Referencia CLI

| Comando | Descripción |
|---------|-------------|
| `bypasser init` | Crea `.bypasser.json` (no pisa si existe) |
| `bypasser init --force` | Regenera la config por defecto |
| `bypasser install` / `uninstall` | Instala o quita el hook pre-commit |
| `bypasser detect` | Puntúa archivos en staging |
| `bypasser detect --all` | Puntúa el working tree sin hacer stage |
| `bypasser detect --verbose` | Muestra señales disparadas |
| `bypasser rewrite <file>` | Reescribe un archivo vía API |
| `bypasser audit` | Detect + rewrite + restage en staging |
| `bypasser audit --dry-run` | Solo detección, sin API |
| `bypasser audit --verbose` | Auditoría con detalle de señales |

---

## Configuración

| Campo | Default | Descripción |
|-------|---------|-------------|
| `baseURL` | `https://api.openai.com/v1` | Endpoint compatible con OpenAI |
| `model` | `gpt-4o-mini` | Nombre del modelo en ese endpoint |
| `threshold` | `0.65` | Reescribir si score IA ≥ esto (0–1) |
| `maxTokens` | `16384` | Máximo de tokens de completion por reescritura |
| `temperature` | `0.4` | Temperatura de muestreo |
| `ignore` | `[]` | Globs extra que nunca se reescriben |
| `thresholds` | `[]` | Umbrales por glob, p. ej. `[{ "pattern": "legacy/**", "value": 0.3 }]` |
| `timeoutMs` | `120000` | Timeout base de reescritura (ms) |
| `timeoutPer1kLinesMs` | `30000` | Extra por cada 1000 líneas por encima de 1000 |
| `maxTimeoutMs` | `600000` | Tope duro de timeout |
| `maxFileLines` | `2000` | Omite reescritura **full-file** por encima; diff/chunk siguen en `auto` |
| `rewriteConcurrency` | `3` | Llamadas API en paralelo por audit |
| `rewriteScope` | `auto` | `file` · `diff` · `chunk` · `auto` |
| `rewriteFullFileBelowLines` | `400` | Corte full-file en `auto` |
| `contextLines` | `60` | Contexto alrededor de hunks |
| `maxChunkLines` | `450` | Máximo de líneas por chunk |
| `structuralCheck` | `true` | Rechaza reescrituras que pierden demasiadas declaraciones top-level |

**Variables de entorno** (pisan el fichero; recomendadas para secretos):

| Variable | Uso |
|----------|-----|
| `BYPASSER_API_KEY` | Clave API |
| `BYPASSER_BASE_URL` | URL base |
| `BYPASSER_MODEL` | Modelo |
| `OPENAI_API_KEY` | Clave alternativa |
| `BYPASSER_VERBOSE` | `1` → salida verbose en audit/hook |
| `BYPASSER_HOOK_EXCLUDED_REPOS` | Nombres de carpeta de repo separados por comas para bloquear `install` |
| `BYPASSER_SKILL_LOCALE` | `es` → prompt humanizer en español; por defecto inglés |

### Elección de modelo (importante)

El rewriter espera **el mismo fragmento de vuelta**, humanizado — no un resumen comprimido. Modelos que devuelven ~10–35 % del input (sin `def`, bucles, tipos…) se **rechazan a propósito**; el archivo se commitea igual y parece que “el hook no hizo nada”.

Antes de confiar en un modelo con archivos grandes, comprueba: líneas de salida ≈ entrada, declaraciones intactas. **`gpt-4o-mini`** es un default razonable; en local o proxy, elige uno que devuelva fragmentos completos.

### Ejemplos de proveedores

| Proveedor | `baseURL` |
|----------|-----------|
| OpenAI | `https://api.openai.com/v1` |
| [Groq](https://groq.com) | `https://api.groq.com/openai/v1` |
| [OpenRouter](https://openrouter.ai) | `https://openrouter.ai/api/v1` |
| [Ollama](https://ollama.ai) | `http://localhost:11434/v1` |
| [LM Studio](https://lmstudio.ai) | `http://localhost:1234/v1` |
| Proxy local (p. ej. 9Router) | `http://localhost:20128/v1` |

Los proxies locales suelen aceptar cualquier `BYPASSER_API_KEY` no vacía (p. ej. `local`).

Plantilla completa para sincronizar muchos repos: [`scripts/canonical-bypasser.json`](scripts/canonical-bypasser.json).

---

## Archivos que siempre se omiten

Ignorados por defecto: lockfiles, `dist/**`, `build/**`, `.next/**`, minificados, la mayoría de `*.json` / `*.yaml` / `*.toml`, y artefactos de bypasser (`*.bak`, `*.bypasser.tmp`). Amplía con `ignore` en `.bypasser.json`.

---

## Puntuación (detector)

Seis **familias de señales** (naming, structure, comments, error-handling, abstraction, uniformity) sobre perfiles por lenguaje — no heurísticas solo en inglés. Los pesos disparados se combinan con la curva saturante `1 - e^(-w/2.5)`: clusters típicos de IA ~**70–85 %**, código humano habitual **por debajo de ~50 %** con umbral **0.65**.

Docblocks informativos (`@param`, varias líneas de contexto) **no** penalizan; solo docblocks telegráficos que repiten lo obvio en casi cada función.

---

## Arquitectura

```
src/
  cli.ts              Enrutador de comandos
  config.ts           .bypasser.json + env + resolución de scope
  detector.ts         Scorer determinista (perfiles por lenguaje)
  rewriter.ts         Cliente API, prompt humanizer, sanitizers
  rewrite-validate.ts Heurísticas de indent / estructura
  rewrite-constants.ts Umbrales de ratios compartidos
  syntax-guard.ts     Backstop Python / JSON en salida ensamblada
  diff-hunks.ts       Parseo unified diff, slice, splice
  chunk-split.ts      Troceado por declaraciones top-level
  concurrency.ts      Pool paralelo acotado
  git.ts              Contenido staged, diff cached en batch, restage
  installer.ts        Install/remove hook + repos excluidos
  audit.ts            detect → rewrite → restage → log → notify
  logger.ts           .bypasser.log + caché .bypasser.state.json
  notifier.ts         Pipeline de toasts Windows
  index.ts            Exports de librería pública
docs/
  SKILL.en.md         Prompt humanizer (default en runtime)
  SKILL.es.md         Prompt humanizer (español)
  SKILL.md            Índice bilingüe + locale
```

---

## Guardas de integridad

Ante la duda, **gana el archivo original**:

- `finish_reason: length` → rechazo
- Corchetes desbalanceados / colapso sospechoso de líneas → rechazo
- Indentación aplanada o declaraciones perdidas → rechazo
- `checkSyntax()` en salida ensamblada (Python / JSON cuando hay parser)
- `restageFile()`: no sobrescribir con vacío, guard anti-encogimiento severo, escritura atómica, `.bak`, rollback si falla `git add`

Las reescrituras fallidas **no bloquean** el commit; revisa `.bypasser.log` y la salida del hook.

---

## Desarrollo

```bash
npm install
npm run build      # obligatorio tras cambios en src/
npm test           # node:test vía scripts/test.js (Node >= 20.6 para tsx)
npm run typecheck
npm run lint
npm run format
```

CI ejecuta lint, typecheck, tests y build en Node 18 / 20 / 22 (ver [`.github/workflows/ci.yml`](.github/workflows/ci.yml)).

Contribuciones bienvenidas — abre un [issue](https://github.com/Pacoaldev/BypasserAI/issues) o un PR.

---

## Límites

- Omite configs, locks y artefactos generados por convención
- No debilita seguridad ni corrección para “parecer humano”
- Detector heurístico — ajusta `threshold` / `thresholds` si hace falta
- Toasts orientados a Windows; hook y CLI funcionan en macOS/Linux

---

## Licencia

[MIT](LICENSE) — © [Pacoaldev](https://github.com/Pacoaldev)

---

<p align="center">
  <a href="https://github.com/Gentleman-Programming/gentle-ai">
    <img width="220" src="https://raw.githubusercontent.com/Gentleman-Programming/gentle-ai/main/docs/assets/brand/built-with-gentle-ai.png" alt="Built with Gentle-AI" />
  </a>
</p>
