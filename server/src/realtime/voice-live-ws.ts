import { createRequire } from "node:module";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import type { Db } from "@paperclipai/db";
import type { DeploymentMode } from "@paperclipai/shared";
import type { BetterAuthSessionResult } from "../auth/better-auth.js";
import { logger } from "../middleware/logger.js";
import type { UpgradeRouter } from "./upgrade-router.js";
import { authorizeCompanyUpgrade } from "./live-events-ws.js";
import { isVoiceGatewayEnabled } from "../voice-gateway-config.js";
import type { VoiceGatewayConfig } from "../voice-gateway-config.js";

const require = createRequire(import.meta.url);
const { WebSocketServer } = require("ws") as {
  WebSocketServer: new (opts: { noServer: boolean }) => {
    clients: Set<GatewaySocket>;
    on(event: string, listener: (...args: unknown[]) => void): void;
    handleUpgrade(
      req: IncomingMessage,
      socket: Duplex,
      head: Buffer,
      callback: (ws: GatewaySocket) => void,
    ): void;
    emit(event: string, ...args: unknown[]): boolean;
  };
};

/** Minimal structural type over a ws WebSocket, sufficient for the gateway. */
export interface GatewaySocket {
  readyState: number;
  ping(): void;
  send(data: string | Buffer): void;
  terminate(): void;
  close(code?: number, reason?: string): void;
  on(event: string, listener: (...args: unknown[]) => void): void;
}

/** Injected by Task 10 with the real registry. */
export interface VoiceGatewayConnector {
  attach(socket: GatewaySocket, ctx: { companyId: string; userId: string }): void;
}

interface IncomingMessageWithContext extends IncomingMessage {
  paperclipVoiceContext?: { companyId: string; userId: string };
}

function rejectUpgrade(socket: Duplex, statusLine: string, message: string) {
  const safe = message.replace(/[\r\n]+/g, " ").trim();
  socket.write(
    `HTTP/1.1 ${statusLine}\r\nConnection: close\r\nContent-Type: text/plain\r\n\r\n${safe}`,
  );
  socket.destroy();
}

/**
 * Registers the /api/voice/live WebSocket upgrade handler on the given router.
 *
 * Auth: reuses authorizeCompanyUpgrade from live-events-ws; companyId is taken
 * from the `companyId` query parameter.
 *
 * When gateway config is disabled, rejects with 503. When companyId is missing,
 * rejects with 400. When auth fails, rejects with 403.
 *
 * On success, hands the upgraded socket to `opts.connector.attach` along with
 * `{ companyId, userId }` context. Task 10 replaces the stub connector with the
 * real session registry.
 */
export function setupVoiceLiveWebSocketServer(
  router: UpgradeRouter,
  db: Db,
  opts: {
    connector: VoiceGatewayConnector;
    deploymentMode: DeploymentMode;
    voiceGatewayConfig: VoiceGatewayConfig;
    resolveSessionFromHeaders?: (headers: Headers) => Promise<BetterAuthSessionResult | null>;
  },
) {
  const wss = new WebSocketServer({ noServer: true });
  const aliveByClient = new Map<GatewaySocket, boolean>();

  const pingInterval = setInterval(() => {
    for (const socket of wss.clients) {
      if (!aliveByClient.get(socket)) {
        socket.terminate();
        continue;
      }
      aliveByClient.set(socket, false);
      socket.ping();
    }
  }, 30_000);

  wss.on("connection", (socket: GatewaySocket, req: IncomingMessage) => {
    const context = (req as IncomingMessageWithContext).paperclipVoiceContext;
    if (!context) {
      socket.close(1008, "missing context");
      return;
    }

    aliveByClient.set(socket, true);

    socket.on("pong", () => {
      aliveByClient.set(socket, true);
    });

    socket.on("close", () => {
      aliveByClient.delete(socket);
    });

    socket.on("error", (err: Error) => {
      logger.warn({ err, companyId: context.companyId }, "voice gateway websocket client error");
    });

    opts.connector.attach(socket, context);
  });

  wss.on("close", () => {
    clearInterval(pingInterval);
  });

  router.register(
    (pathname) => (pathname === "/api/voice/live" ? {} : null),
    (req, socket, head, _match, url) => {
      // Gate on gateway being configured.
      if (!isVoiceGatewayEnabled(opts.voiceGatewayConfig)) {
        rejectUpgrade(socket as Duplex, "503 Service Unavailable", "voice gateway not configured");
        return;
      }

      const companyId = url.searchParams.get("companyId")?.trim() ?? "";
      if (!companyId) {
        rejectUpgrade(socket as Duplex, "400 Bad Request", "missing companyId query param");
        return;
      }

      void authorizeCompanyUpgrade(db, req as IncomingMessage, companyId, url, {
        deploymentMode: opts.deploymentMode,
        resolveSessionFromHeaders: opts.resolveSessionFromHeaders,
      })
        .then((context) => {
          if (!context) {
            rejectUpgrade(socket as Duplex, "403 Forbidden", "forbidden");
            return;
          }

          // Map UpgradeContext actorId to userId (same convention as voice-sessions routes).
          const userId = context.actorId;

          const reqWithContext = req as IncomingMessageWithContext;
          reqWithContext.paperclipVoiceContext = { companyId, userId };

          wss.handleUpgrade(req as IncomingMessage, socket as Duplex, head, (ws: GatewaySocket) => {
            wss.emit("connection", ws, reqWithContext);
          });
        })
        .catch((err) => {
          logger.error({ err, path: (req as IncomingMessage).url }, "failed voice websocket upgrade");
          rejectUpgrade(socket as Duplex, "500 Internal Server Error", "upgrade failed");
        });
    },
  );

  return wss;
}
