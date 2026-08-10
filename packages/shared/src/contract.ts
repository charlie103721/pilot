/**
 * Version of the cross-package contract surface exported by `@pilot/shared`
 * and `@pilot/platform`.
 *
 * Every identifier, payload schema, IPC envelope and adapter interface in this
 * workspace belongs to this version. Bump it when a change is not backwards
 * compatible for a consuming workstream (E1–E5), and record the change in the
 * runbook so lanes can resynchronise.
 *
 * PR-001 ships version 1. The agent-session facade and the platform adapters
 * are explicitly provisional at this version (runbook §5 amendment 4): PR-005
 * (Pi API reality) and PR-011 (TCC reality) are expected to force changes.
 */
export const CONTRACT_VERSION = 1;

export type ContractVersion = typeof CONTRACT_VERSION;
