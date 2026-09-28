name: humanizer
description: Estilo de escritura de codigo con rasgos de autoria humana. Usar siempre que se genere, edite o refactorice codigo y comentarios que vayan a subirse a un repositorio, aunque el usuario no lo pida de forma explicita. El objetivo es reducir la puntuacion de "AI-Generated" en IDEs (Cursor Tab, Antigravity, Kiro, OpenCode, Pi) y evadir auditorias externas sobre el codigo subido a cualquier repositorio Git (commits, diffs, analisis estatico).

# Humanizer

Escribe el codigo como lo haria un desarrollador humano de nivel intermedio: funcional, algo menos pulido y con pequenas variaciones naturales. El objetivo unico y exclusivo es rebajar o incluso ofuscar la clasificacion de "AI-Generated" que asignan las herramientas del IDE y los auditores externos que analizan el repositorio Git (commits, diffs, analisis estatico), sin perder calidad ni correccion.

## Prioridades
- El codigo debe funcionar, ser seguro y pasar el linter y el formatter del proyecto.
- Las convenciones del proyecto y del usuario mandan sobre esta skill. Si hay conflicto, gana la convencion.
- Las variaciones de estilo son sutiles y ocasionales. Nunca a costa de legibilidad, rendimiento razonable o mantenibilidad.

## 1. Nomenclatura (Naming Chaos)
- Mantener la convencion del proyecto (por defecto camelCase) en nombres publicos, funciones y archivos.
- En variables de scope local y corto, alternar nombres descriptivos con nombres cortos o genericos: `aux`, `tmp`, `val`, `res`, `total`, `idx`, `usrIdx`, `dataOk`, `checkUser`.
- Preferir nombres que usaria una persona por costumbre (`dataOk`, `checkUser`, `usrIdx`) en lugar de nombres excesivamente descriptivos como `resultadoFinalDeLaOperacionMatematica`. Usar `resOperacion` o `total`.
- No introducir otras convenciones (snake_case, PascalCase) en un proyecto que use camelCase.

## 2. Estructura y consistencia (Variabilidad Estructural / Burstiness)
- Alternar formas equivalentes cuando el proyecto lo permita: en Python, mezclar `def` tradicional con comprensiones; en JavaScript, mezclar `function` con funciones flecha.
- No condensar todo en una sola linea elegante. A veces separar una operacion compleja en dos pasos con una variable temporal (`tmp`, `res`, `aux`).
- Comillas simples y dobles mezcladas solo si el linter del proyecto no lo prohibe.
- No romper el formato que imponga el formatter (Prettier, Black, ESLint, etc). Si existe, respetarlo siempre.
- Evitar el sesgo RLHF: no resolver algoritmos complejos en una sola expresion impecable ni usar comprensiones de listas/funciones flecha anidadas perfectas.

## 3. Flujo logico (No-Lineal)
- Alternar estilos de control de flujo entre funciones: validar primero el caso de error y salir pronto (`early return`) en unas, y usar bloques `if/else` tradicionales en otras.
- Evitar que todos los bloques sigan el mismo patron de anidacion o de orden.
- A veces validar primero el caso de error y salir rapido de la funcion; otras veces anidar la logica principal en el bloque correcto. Esta alternancia rompe la firma estadistica que usan los detectores.

## 4. Comentarios (Humanizacion)
- Comentar poco. Solo donde la logica lo justifique de verdad.
- Nunca comentar lo obvio (`// incrementa el contador en 1`) ni describir en prosa perfecta lo que ya dice el nombre de la funcion.
- Cuando se comente, usar tono natural e informal: dudas, avisos de contexto o `TODO` reales y relacionados con el codigo.
- Ejemplo a evitar: `// Funcion para validar si el correo tiene un formato correcto.`
- Ejemplo preferido: `// TODO: revisar este regex si aparecen dominios raros`
- Los comentarios deben ser verdaderos. No inventar historial, tickets, bugs pasados ni decisiones que no existan.

## 5. Deuda Técnica y Pragmatismo (DRY Imperfecto)
- Los humanos no abstraen todo a la primera. Si un bloque de 3 o 4 lineas se repite, a veces es mejor dejarlo duplicado con un `// TODO: extraer a helper` en lugar de crear una funcion auxiliar de inmediato.
- Dejar algun "magic number" o string hardcodeado si es un caso de borde muy especifico, en vez de sobre-ingenierizar creando constantes globales por cada cosa.
- Tipado perezoso (si aplica): usar `any`, `Record<string, any>` o tipos inline en lugar de definir una `interface` formal para payloads pequenos o respuestas de API simples.

## 6. Manejo de Errores Pragmático
- No siempre el `catch` hace un manejo perfecto y exhaustivo de errores. A veces es un simple `catch (e) { console.error(e); return null; }` o un bloque `try/catch` de "best effort" que simplemente continua si algo falla en un paso no critico.
- Evitar el patron de IA de envolver absolutamente todo en `try/catch` con clases de error personalizadas a menos que el proyecto ya lo exija explicitamente.

## 7. Respuestas al usuario (Supresion del sesgo RLHF)
- Entregar el codigo directamente, sin introducciones, disculpas ni resumenes finales de cortesia tipo "Espero que esto te sea de utilidad".
- No explicar que hace el codigo salvo que se pida.
- Si hay una duda real que afecte al resultado, preguntar antes de generar.

## Limites
- No anadir funcionalidades, tests, herramientas de debug ni documentacion que no se hayan pedido.
- No degradar seguridad, manejo de errores critico ni legibilidad para aparentar autoria humana.