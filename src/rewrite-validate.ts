import { resolveLanguage } from "./detector.js";

const STRUCTURAL_DROP_RATIO = 0.15;

function countDeclarations(code: string, filePath: string): number {
  const p = resolveLanguage(filePath, code);
  const seen = new Set<number>();
  const re = new RegExp(
    p.fnDecl.source,
    p.fnDecl.flags.includes("g") ? p.fnDecl.flags : p.fnDecl.flags + "g"
  );
  let m: RegExpExecArray | null;
  while ((m = re.exec(code)) !== null) {
    seen.add(m.index);
    if (m.index === re.lastIndex) re.lastIndex++;
  }
  // Classes / modules — rough top-level shape per language
  const classRe =
    p.id === "python"
      ? /\bclass\s+\w+/g
      : p.id === "ruby"
        ? /\bclass\s+\w+/g
        : /\b(?:export\s+)?(?:abstract\s+)?class\s+\w+/g;
  let c: RegExpExecArray | null;
  while ((c = classRe.exec(code)) !== null) {
    seen.add(c.index);
    if (c.index === classRe.lastIndex) classRe.lastIndex++;
  }
  return seen.size;
}

/**
 * ponytail: regex/heuristic — catches dropped functions, not renamed refactors.
 */
export function looksStructurallyBroken(
  before: string,
  after: string,
  filePath: string
): boolean {
  const beforeCount = countDeclarations(before, filePath);
  if (beforeCount < 3) return false;
  const afterCount = countDeclarations(after, filePath);
  return afterCount < beforeCount * (1 - STRUCTURAL_DROP_RATIO);
}
