// Public API — for use as a library
export { detectAI, extractAddedLines, countChangedLines, isTypeScriptPath, resolveLanguage } from "./detector.js";
export { rewriteFile, contentHash } from "./rewriter.js";
export { hasUnbalancedBrackets } from "./bracket-balance.js";
export { runAudit } from "./audit.js";
export { loadConfig, resolveThreshold, BUILT_IN_IGNORE } from "./config.js";
export { getStagedFiles, getWorkingTreeFiles, restageFile, matchGlob, shouldIgnore } from "./git.js";
export {
  install,
  uninstall,
  isHookInstallExcluded,
  HOOK_INSTALL_EXCLUDED_REPO_NAMES,
} from "./installer.js";

export type { BypasserConfig, ThresholdRule } from "./config.js";
export type { DetectorResult, Signal, SignalFamily, LanguageId, LanguageProfile } from "./detector.js";
export type { RewriteResult } from "./rewriter.js";
export type { AuditResult, FileAuditResult } from "./audit.js";
export type { StagedFile, FileSource } from "./git.js";
