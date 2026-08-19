/**
 * @aytracker/module-audit — the audit vocabulary, redaction and sink port.
 *
 * Every module publishes domain events; this module subscribes and writes audit rows. That is
 * why no other module imports it: audit is a consumer, not a dependency.
 */

export {
  AUDIT_ACTIONS,
  REDACTED_PLACEHOLDER,
  buildAuditEntry,
  redactMetadata,
  truncateIpAddress,
  type AuditAction,
  type AuditEntry,
  type AuditSink,
} from './domain/audit.js';
