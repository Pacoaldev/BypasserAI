// Public API — for use as a library
export { detectAI, extractAddedLines, countChangedLines, isTypeScriptPath, resolveLanguage } from "./detector.js";
export { maskSource } from "./mask.js";
export { rewriteFile, contentHash } from "./rewriter.js";
export { hasUnbalancedBrackets } from "./bracket-balance.js";
export { runAudit, selectUnresolvedFiles, providerHost, auditFileStatus } from "./audit.js";
export { writeAuditEvent, readAuditEvents, pruneState } from "./logger.js";
export { computeStats, renderStats, bucketReason } from "./stats.js";
export { loadConfig, resolveThreshold, BUILT_IN_IGNORE } from "./config.js";
export {
  extractInlineApiKey,
  isConfigGitignored,
  inspectConfigSecrets,
  redactKey,
} from "./secrets.js";
export type { ConfigSecretFindings } from "./secrets.js";
export { getStagedFiles, getWorkingTreeFiles, getTrackedFiles, restageFile, matchGlob, shouldIgnore } from "./git.js";
export {
  install,
  uninstall,
  isHookInstallExcluded,
  HOOK_INSTALL_EXCLUDED_REPO_NAMES,
} from "./installer.js";

export { notify, notificationCommand } from "./notifier.js";
export type { NotificationMode } from "./config.js";
export type { BypasserConfig, ThresholdRule } from "./config.js";
export type { DetectorResult, Signal, SignalFamily, LanguageId, LanguageProfile } from "./detector.js";
export type { MaskedSource } from "./mask.js";
export type { RewriteResult } from "./rewriter.js";
export type { AuditResult, FileAuditResult } from "./audit.js";
export type { AuditLogEvent } from "./logger.js";
export type { AuditStats, FileHotspot } from "./stats.js";
export type { StagedFile, FileSource } from "./git.js";
