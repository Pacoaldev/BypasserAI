// Public API — for use as a library
export { detectAI, extractAddedLines, countChangedLines, isTypeScriptPath } from "./detector.js";
export { rewriteFile, contentHash } from "./rewriter.js";
export { runAudit } from "./audit.js";
export { loadConfig, resolveThreshold, BUILT_IN_IGNORE } from "./config.js";
export { getStagedFiles, getWorkingTreeFiles, restageFile, matchGlob, shouldIgnore } from "./git.js";
export { install, uninstall } from "./installer.js";

export type { BypasserConfig, ThresholdRule } from "./config.js";
export type { DetectorResult, Signal, SignalFamily } from "./detector.js";
export type { RewriteResult } from "./rewriter.js";
export type { AuditResult, FileAuditResult } from "./audit.js";
export type { StagedFile, FileSource } from "./git.js";
