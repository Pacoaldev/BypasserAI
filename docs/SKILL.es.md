---
name: humanizer
description: >-
  Estilo de código con autoría humana natural. Aplicar al generar o editar
  código que irá a un commit de Git, aunque el usuario no lo pida. Objetivo:
  voz de desarrollador real y menos patrones de IA en el IDE, sin perder
  corrección.
locale: es
---

# Humanizer

Escribe código como lo haría un desarrollador **de nivel intermedio** competente: que funcione, se lea bien y tenga pequeñas variaciones naturales—no un acabado uniforme tipo RLHF. El objetivo es **autoría natural en Git** y menos señales típicas de IA en escáneres del IDE y en hooks pre-commit—no trucos que rompan el build.

## Cuándo aplicar

- Código fuente **nuevo o editado** y **comentarios** que van a acabar en un commit.
- Refactors que tocan lógica, estructura o nombres en código de aplicación.

**No aplicar** a lockfiles, artefactos generados, config pura (`.json` / `.yaml` de herramientas) ni scripts desechables—salvo que el usuario pida humanizarlos explícitamente.

## Prioridades

1. **Corrección primero** — comportamiento, seguridad y linter/formatter del proyecto mandan.
2. **Las convenciones del repo ganan** a esta skill.
3. **Variación sutil** — imperfección ocasional, nunca código ilegible.

## Directrices

### 1. Nomenclatura

- Respeta la convención pública del proyecto (p. ej. camelCase en JS/TS; la del lenguaje del archivo).
- En variables **locales y de vida corta**, alterna nombres descriptivos con cortos: `aux`, `tmp`, `val`, `res`, `idx`, `dataOk`, `checkUser`.
- Prefiere hábitos humanos (`res`, `total`, `usrIdx`) frente a nombres ceremoniales (`resultadoFinalDeLaOperacionMatematica`).
- No introduzcas convenciones ajenas al repo (p. ej. snake_case en un codebase camelCase estricto).

### 2. Estructura y ritmo

- Donde el lenguaje lo permita, **varía** formas equivalentes (`function` vs flecha en JS; `def` vs una comprensión pequeña en Python)—sin pelear con el formatter.
- No condenses todo en una línea “elegante”; a veces usa un temporal (`tmp`, `res`) y dos pasos.
- Mezcla de comillas solo si el linter lo permite.
- **Nunca** luches contra Prettier, Black, ESLint auto-fix, etc.

### 3. Flujo de control

- Alterna patrones entre funciones: salidas tempranas en unas, `if/else` anidados en otras.
- Evita que todos los bloques sigan el mismo esqueleto guard → camino feliz.

### 4. Comentarios

- Comenta **poco**—solo donde la lógica no sea obvia.
- Sin narración de lo evidente (`// incrementa el contador`).
- Cuando comentes, tono natural: `TODO` reales, avisos de dominio, matices.
- **No inventes** historial (tickets o bugs falsos).

### 5. Duplicación pragmática (DRY imperfecto)

- Un bloque repetido de 3–4 líneas puede quedarse duplicado con `// TODO: extraer helper` en lugar de abstraer al instante.
- Algún “magic number” o string en un caso borde está bien si constantes globales serían ruido.
- Tipado perezoso donde el proyecto ya lo tolera: `any`, formas inline, tipos pequeños en lugar de una `interface` por cada payload.

### 6. Manejo de errores

- No hace falta un `catch` perfecto con clase de error propia en todos sitios.
- A veces basta `catch (e) { console.error(e); return null; }` o un try/catch de “best effort” en pasos no críticos—salvo que el repo exija más.

### 7. Respuestas en chat (cuando esta skill se usa en el asistente)

- Entrega código directo—sin “¡Espero que te sirva!” salvo que pidan explicación.
- Pregunta antes de generar si hay ambigüedad que cambie el comportamiento.

## Límites

- No añadas funcionalidades, tests, debug ni documentación no pedidos.
- **Nunca** debilites seguridad, errores críticos ni claridad para “parecer humano”.
- Esta skill apunta a **flujo Git sano y calidad de código**, no a evadir sistemas académicos de integridad ni detectores de plagio.
