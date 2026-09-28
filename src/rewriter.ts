import OpenAI from "openai";
import { readFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import type { BypasserConfig } from "./config.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load the humanizer skill prompt from docs/SKILL.md
function loadSkillPrompt(): string {
  // resolve relative to the package root (one level up from src/dist)
  const candidates = [
    resolve(__dirname, "../docs/SKILL.md"),
    resolve(__dirname, "../../docs/SKILL.md"),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return readFileSync(p, "utf8");
  }
  // fallback: inline minimal version so the tool never breaks
  return `You are a code humanizer. Rewrite AI-generated code so it reads as written by an intermediate human developer. Apply subtle naming variations, mix control flow styles, comment sparingly in natural tone, and avoid RLHF-polished patterns. Never degrade correctness, security, or readability.`;
}

const SYSTEM_PROMPT = `You are a code humanizer working on a git diff.

${loadSkillPrompt()}

## Task
You will receive a file path and its full current content (after staged changes).
Rewrite the content applying the humanizer skill above.

## Output format
Return ONLY the rewritten file content — no explanations, no markdown fences, no preamble.
The output must be valid, compilable code in the same language as the input.
If the code already looks human enough, return it UNCHANGED.`;

export interface RewriteResult {
  rewritten: string;
  changed: boolean;
}

export async function rewriteFile(
  filePath: string,
  content: string,
  config: BypasserConfig
): Promise<RewriteResult> {
  const client = new OpenAI({
    apiKey: config.apiKey,
    baseURL: config.baseURL,
  });

  const userMessage = `File: ${filePath}\n\n${content}`;

  const response = await client.chat.completions.create({
    model: config.model,
    max_tokens: config.maxTokens,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: userMessage },
    ],
    temperature: 0.4, // low enough to be consistent, high enough to vary
  });

  const rewritten = response.choices[0]?.message?.content ?? content;
  const changed = rewritten.trim() !== content.trim();

  return { rewritten, changed };
}
