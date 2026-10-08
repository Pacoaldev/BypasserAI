/**
 * Detector benchmark + calibration harness.
 *
 * Why this exists
 * ---------------
 * The detector's score curve (`1 - e^(-w / SCORE_REFERENCE_WEIGHT)`) was tuned
 * by hand. There was no objective number saying whether the detector is *good*:
 * only a handful of unit tests asserting "this file is above 0.65" / "this one
 * is below it". This harness runs the detector over an annotated corpus
 * (`test/corpus/corpus.json`) and reports the metrics that actually matter:
 *
 *   - confusion matrix at the default 0.65 threshold
 *   - precision / recall / F1 (AI = positive class)
 *   - per-sample scores, sorted so the worst errors surface first
 *   - the threshold that maximises F1 across the corpus (so the default can be
 *     justified from data, not vibes)
 *
 * It also powers the golden snapshot test (`test/bench-detector.test.ts`):
 * `--snapshot` writes `test/corpus/detector-snapshot.json` with a score per
 * sample, and the test asserts the current run matches it. Any weight or regex
 * change that moves a score beyond `SNAPSHOT_TOLERANCE` fails CI, forcing the
 * change to be acknowledged (`BYPASSER_UPDATE_SNAPSHOT=1`) rather than slipping
 * through unnoticed.
 *
 * Usage:
 *   npm run bench                         # human-readable report
 *   npm run bench -- --snapshot           # rewrite the golden snapshot
 *   BYPASSER_UPDATE_SNAPSHOT=1 npm test   # let the snapshot test re-record
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { detectAI } from "../src/detector.js";

export interface CorpusSample {
  id: string;
  label: "ai" | "human";
  lang: string;
  path: string;
  code: string;
}

export interface Corpus {
  samples: CorpusSample[];
}

export interface SampleScore {
  id: string;
  label: "ai" | "human";
  lang: string;
  score: number;
}

export interface BenchMetrics {
  threshold: number;
  truePositives: number;
  falseNegatives: number;
  falsePositives: number;
  trueNegatives: number;
  precision: number;
  recall: number;
  f1: number;
  accuracy: number;
  bestThreshold: number;
  bestF1: number;
  scores: SampleScore[];
}

const HERE = dirname(fileURLToPath(import.meta.url));
const CORPUS_PATH = resolve(HERE, "../test/corpus/corpus.json");
export const SNAPSHOT_PATH = resolve(HERE, "../test/corpus/detector-snapshot.json");
/** A score may drift this much before the golden snapshot test fails. */
export const SNAPSHOT_TOLERANCE = 0.02;
export const DEFAULT_THRESHOLD = 0.65;

export function loadCorpus(path = CORPUS_PATH): Corpus {
  return JSON.parse(readFileSync(path, "utf8")) as Corpus;
}

function safeDiv(a: number, b: number): number {
  return b === 0 ? 0 : a / b;
}

/** Compute precision/recall/F1 for one threshold (AI is the positive class). */
function metricsAt(scores: SampleScore[], threshold: number) {
  let tp = 0;
  let fn = 0;
  let fp = 0;
  let tn = 0;
  for (const s of scores) {
    const predictedAi = s.score >= threshold;
    if (s.label === "ai") {
      if (predictedAi) tp++;
      else fn++;
    } else {
      if (predictedAi) fp++;
      else tn++;
    }
  }
  const precision = safeDiv(tp, tp + fp);
  const recall = safeDiv(tp, tp + fn);
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  return { tp, fn, fp, tn, precision, recall, f1, accuracy: safeDiv(tp + tn, scores.length) };
}

/** Score every corpus sample once. */
export function scoreCorpus(corpus: Corpus): SampleScore[] {
  return corpus.samples.map((s) => ({
    id: s.id,
    label: s.label,
    lang: s.lang,
    score: detectAI(s.code, s.path).score,
  }));
}

/**
 * Sweep every candidate threshold (0.05 … 0.95 in 0.01 steps) and keep the one
 * that maximises F1; ties break toward the higher threshold (fewer false
 * positives — rewriting human code is the more expensive mistake).
 */
export function computeMetrics(
  scores: SampleScore[],
  threshold = DEFAULT_THRESHOLD
): BenchMetrics {
  const m = metricsAt(scores, threshold);

  let bestThreshold = threshold;
  let bestF1 = -1;
  for (let t = 0.05; t <= 0.95001; t += 0.01) {
    const cand = metricsAt(scores, Math.round(t * 100) / 100);
    if (cand.f1 > bestF1 || (cand.f1 === bestF1 && t > bestThreshold)) {
      bestF1 = cand.f1;
      bestThreshold = Math.round(t * 100) / 100;
    }
  }

  return {
    threshold,
    truePositives: m.tp,
    falseNegatives: m.fn,
    falsePositives: m.fp,
    trueNegatives: m.tn,
    precision: m.precision,
    recall: m.recall,
    f1: m.f1,
    accuracy: m.accuracy,
    bestThreshold,
    bestF1: bestF1 < 0 ? 0 : bestF1,
    scores,
  };
}

/** Deterministic snapshot payload: id → rounded score. */
export function buildSnapshot(scores: SampleScore[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const s of [...scores].sort((a, b) => a.id.localeCompare(b.id))) {
    out[s.id] = Math.round(s.score * 1000) / 1000;
  }
  return out;
}

export function readSnapshot(path = SNAPSHOT_PATH): Record<string, number> {
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, number>;
}

export function writeSnapshot(scores: SampleScore[], path = SNAPSHOT_PATH): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(buildSnapshot(scores), null, 2) + "\n", "utf8");
}

function pct(x: number): string {
  return (x * 100).toFixed(0) + "%";
}

export function renderReport(metrics: BenchMetrics): string {
  const lines: string[] = [];
  const t = metrics.threshold;
  lines.push("BypasserAI — detector benchmark");
  lines.push("=".repeat(48));
  lines.push(`corpus samples : ${metrics.scores.length}`);
  lines.push(`threshold      : ${t}`);
  lines.push("");
  lines.push("confusion matrix (AI = positive)");
  lines.push(`  true positives  (AI flagged)     : ${metrics.truePositives}`);
  lines.push(`  false negatives (AI missed)      : ${metrics.falseNegatives}`);
  lines.push(`  false positives (human flagged)  : ${metrics.falsePositives}`);
  lines.push(`  true negatives  (human cleared)  : ${metrics.trueNegatives}`);
  lines.push("");
  lines.push(`precision : ${pct(metrics.precision)}`);
  lines.push(`recall    : ${pct(metrics.recall)}`);
  lines.push(`F1        : ${pct(metrics.f1)}`);
  lines.push(`accuracy  : ${pct(metrics.accuracy)}`);
  lines.push("");
  lines.push(
    `best F1   : ${pct(metrics.bestF1)} at threshold ${metrics.bestThreshold} ` +
      `(default ${t} — ${metrics.bestThreshold === t ? "already optimal" : "consider re-tuning"})`
  );
  lines.push("");
  lines.push("scores (worst errors first)");
  const sorted = [...metrics.scores].sort((a, b) => {
    const aErr = a.label === "ai" ? 1 - a.score : a.score;
    const bErr = b.label === "ai" ? 1 - b.score : b.score;
    return bErr - aErr;
  });
  for (const s of sorted) {
    const predicted = s.score >= t ? "AI " : "ok ";
    const correct = (s.score >= t) === (s.label === "ai") ? "  " : " ✗";
    lines.push(
      `  ${correct} ${s.id.padEnd(26)} [${s.label.padEnd(5)}] ${predicted} ${pct(s.score)}`
    );
  }
  return lines.join("\n");
}

function main(): void {
  const args = process.argv.slice(2);
  const corpus = loadCorpus();
  const scores = scoreCorpus(corpus);
  const metrics = computeMetrics(scores);

  if (args.includes("--snapshot")) {
    writeSnapshot(scores);
    console.log(`wrote snapshot → ${SNAPSHOT_PATH}`);
  }

  console.log(renderReport(metrics));
}

const invokedDirectly =
  process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) main();
