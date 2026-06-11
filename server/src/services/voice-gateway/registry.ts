/**
 * Per-user session registry for the voice gateway (FRE-1296).
 *
 * Implements VoiceGatewayConnector so it can be passed as opts.connector to
 * setupVoiceLiveWebSocketServer.
 *
 * Semantics:
 *   - attach(socket, { companyId, userId }): if a session exists for userId,
 *     call session.attachSocket(socket) (takeover); otherwise create a new
 *     session via the injected factory and attach the socket.
 *   - When a session is destroyed, its entry is removed from the map.
 *   - socket.on("close") triggers session.clientDisconnected() (warm-hold).
 *   - socket.on("message") is wired to session.handleBinary / handleMessage.
 */

import type { GatewaySocket, VoiceGatewayConnector } from "../../realtime/voice-live-ws.js";
import type { GatewaySessionHandle } from "./session.js";
import { parseClientMessage } from "./protocol.js";

// ---------------------------------------------------------------------------
// Registry deps
// ---------------------------------------------------------------------------

export interface GatewayRegistryDeps {
  /**
   * Factory that creates a new GatewaySessionHandle for the given userId.
   * The registry passes the companyId separately via ctx to the session
   * through the factory closure (callers build the factory with companyId
   * per-call, or include it in the handle's ctx).
   *
   * The factory must wire up the session's destroy callback to call
   * registry.remove(userId) — handled internally here via a wrapping.
   */
  sessionFactory(userId: string, companyId: string): GatewaySessionHandle;

  /** Warm-hold duration in ms (forwarded from VoiceGatewayConfig). */
  warmHoldMs: number;
}

// ---------------------------------------------------------------------------
// Registry implementation
// ---------------------------------------------------------------------------

export function createGatewayRegistry(
  deps: GatewayRegistryDeps,
): VoiceGatewayConnector & { /** Removes entry for userId (called on destroy). */
  _remove(userId: string): void; } {

  const sessions = new Map<string, GatewaySessionHandle>();

  function remove(userId: string): void {
    sessions.delete(userId);
  }

  const connector = {
    _remove: remove,

    attach(socket: GatewaySocket, ctx: { companyId: string; userId: string }): void {
      const { companyId, userId } = ctx;

      let session = sessions.get(userId);

      if (!session) {
        // Create a new session
        session = deps.sessionFactory(userId, companyId);
        sessions.set(userId, session);

        // When the session is destroyed (by any means), remove it from the map.
        // We wrap the destroy method to hook into removal.
        const originalDestroy = session.destroy.bind(session);
        session.destroy = function wrappedDestroy(reason: string): void {
          remove(userId);
          originalDestroy(reason);
        };
      }

      const s = session;

      // Attach the socket (takeover if another socket was previously attached)
      s.attachSocket(socket);

      // Wire socket events
      socket.on("message", (data: Buffer | string, isBinary: boolean) => {
        if (isBinary) {
          const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as unknown as ArrayBuffer);
          s.handleBinary(buf);
          return;
        }

        const raw = typeof data === "string" ? data : (data as Buffer).toString("utf8");
        const msg = parseClientMessage(raw);
        if (msg) {
          s.handleMessage(msg);
        }
      });

      socket.on("close", () => {
        s.clientDisconnected();
      });
    },
  };

  return connector;
}
