/**
 * CollaborationRoom domain constants (design §4, §6, §7, §12).
 *
 * These are frozen contract values shared by the room store, service and
 * tests. They must not be redefined ad hoc at call sites.
 */

export const ROOM_SCHEMA_VERSION = 3;

export const ROOM_TABLES = [
  'rooms',
  'room_members',
  'room_sequences',
  'room_messages',
  'room_message_deliveries',
  'room_recipient_cursors',
  'room_membership_leases',
  'room_execution_audit',
  'room_history_read_audits',
  'room_history_read_audit_meta',
];

export const ROOM_MAX_ACTIVE_AGENT_MEMBERS = 6;
export const ROOM_TEAM_ONCE_MAX_AGENT_REPLIES = 6;
export const ROOM_MENTION_CHAIN_MAX_DEPTH = 2;
export const ROOM_WAKE_CLAIM_GRACE_MS = 60_000;
export const ROOM_MEMBERSHIP_LEASE_TTL_MS = 30_000;

export const ROOM_INTENT_KINDS = ['room_message', 'room_system_event'];

export const ROOM_ERROR_CODES = {
  ROOM_NOT_FOUND: 'room_not_found',
  ROOM_ARCHIVED: 'room_archived',
  ROOM_REVISION_CONFLICT: 'room_revision_conflict',
  ROOM_MEMBERSHIP_REQUIRED: 'room_membership_required',
  ROOM_MEMBER_LIMIT_EXCEEDED: 'room_member_limit_exceeded',
  ROOM_MEMBER_DUPLICATE: 'room_member_duplicate',
  ROOM_MESSAGE_DUPLICATE: 'room_message_duplicate',
  ROOM_MESSAGE_NOT_FOUND: 'room_message_not_found',
  ROOM_SCOPE_MISMATCH: 'room_scope_mismatch',
  ROOM_ACTOR_FORBIDDEN: 'room_actor_forbidden',
  ROOM_ACTOR_IDENTITY_MISMATCH: 'room_actor_identity_mismatch',
  ROOM_AUTHENTICATION_REQUIRED: 'room_authentication_required',
  ROOM_LAST_OWNER_REMOVAL_FORBIDDEN: 'room_last_owner_removal_forbidden',
  ROOM_MEMBER_REMOVAL_PENDING: 'room_member_removal_pending',
  ROOM_MEMBERSHIP_LEASE_REQUIRED: 'room_membership_lease_required',
  ROOM_INTENT_MUST_USE_ROOM_SERVICE: 'room_intent_must_use_room_service',
  ROOM_INPUT_INVALID: 'room_input_invalid',
  BROKER_UNAVAILABLE: 'broker_unavailable',
};

export const ROOM_REQUEST_SOURCES = ['user', 'agent', 'system'];

export const ROOM_SYSTEM_SERVICES = ['kswarm', 'intent-broker', 'desktop'];
