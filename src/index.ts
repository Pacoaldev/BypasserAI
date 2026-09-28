// Public API — for use as a library
export { detectAI, extractAddedLines } from "./detector.js";
export { rewriteFile } from "./rewriter.js";
export { runAudit } from "./audit.js";
export { loadConfig, BUILT_IN_IGNORE } from "./config.js";
export { getStagedFiles, restageFile } from "./git.js";
export { install, uninstall } from "./installer.js";

export type { BypasserConfig } from "./config.js";
export type { DetectorResult, Signal, SignalFamily } from "./detector.js";
export type { RewriteResult } from "./rewriter.js";
export type { AuditResult, FileAuditResult } from "./audit.js";
export type { StagedFile } from "./git.js";
