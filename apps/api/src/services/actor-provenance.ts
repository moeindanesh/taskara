import type { ActorType, AgentRuntime, UserKind } from '@taskara/db';

/**
 * Who authored a row, snapshotted at write time.
 *
 * Two claims of very different strength travel together here, and the difference matters when
 * anyone later reasons about what a row proves:
 *
 * - `actorType` is **authenticated**. It is derived from the `kind` of the User the request
 *   authenticated as, on the server, from the database row. No header contributes to it.
 * - `actorRuntime` is **asserted**. Nothing authenticates which runtime is on the other end of the
 *   socket, so it is a self-declaration — recorded only for an actor whose identity already proves
 *   it an agent, and worth exactly what the operator's own agent credential is worth.
 *
 * Both are written onto the row rather than re-joined at read time. `User.kind` and
 * `WorkspaceMember.role` carry no history, so re-joining would let a later identity change
 * silently reinterpret work that has already happened.
 */
export interface ActorProvenance {
  actorType: ActorType;
  actorRuntime: AgentRuntime | null;
}

/** No attributable actor: scheduled jobs, digests, nudges. */
export const SYSTEM_PROVENANCE: ActorProvenance = { actorType: 'SYSTEM', actorRuntime: null };

const AGENT_RUNTIMES: readonly AgentRuntime[] = ['CLAUDE_CODE', 'CODEX', 'OPENCLAW', 'HERMES'];

/**
 * The single place an actorType is decided.
 *
 * `channel` is what the authentication channel calls a human — `USER` for a session or an API
 * caller, `MATTERMOST` for the Mattermost bot. An agent overrides it, because the question
 * "was this an agent?" must have one answer regardless of how the agent reached us.
 */
export function deriveActorProvenance(input: {
  userKind: UserKind;
  channel: ActorType;
  declaredRuntime?: string;
}): ActorProvenance {
  if (input.userKind !== 'AGENT') return { actorType: input.channel, actorRuntime: null };
  return { actorType: 'AGENT', actorRuntime: parseAgentRuntime(input.declaredRuntime) };
}

/**
 * Reads a client-declared runtime. Anything unrecognised becomes null rather than an error: the
 * declaration is a hint, and a client should not be able to fail a write by mistyping one.
 */
export function parseAgentRuntime(declared?: string | null): AgentRuntime | null {
  const normalized = declared?.trim().toUpperCase().replace(/[\s-]+/g, '_');
  if (!normalized) return null;
  return AGENT_RUNTIMES.find((runtime) => runtime === normalized) ?? null;
}

/** Provenance plus who it was, for a row that stores the actor's id alongside it. */
export interface ActorAttribution extends ActorProvenance {
  actorId: string | null;
}

/** No attributable actor, for a row that stores an actorId. */
export const SYSTEM_ATTRIBUTION: ActorAttribution = { actorId: null, ...SYSTEM_PROVENANCE };

/** The provenance half of an actor, for spreading into a row that records who caused it. */
export function provenanceOf(actor: ActorProvenance): ActorProvenance {
  return { actorType: actor.actorType, actorRuntime: actor.actorRuntime };
}

/** Full attribution for a row that also stores the actor's id. */
export function attributedTo(actor: ActorProvenance & { user: { id: string } }): ActorAttribution {
  return { actorId: actor.user.id, actorType: actor.actorType, actorRuntime: actor.actorRuntime };
}
