import type { IncomingMessage, Server as HttpServer } from "node:http";
import type { Duplex } from "node:stream";

export type UpgradeMatch = Record<string, string>;
export type UpgradeMatcher = (pathname: string) => UpgradeMatch | null;
export type UpgradeHandler = (
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  match: UpgradeMatch,
  url: URL,
) => void;

export interface UpgradeRouter {
  register(matcher: UpgradeMatcher, handler: UpgradeHandler): void;
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void;
  bind(server: HttpServer): void;
}

export function createUpgradeRouter(): UpgradeRouter {
  const routes: Array<{ matcher: UpgradeMatcher; handler: UpgradeHandler }> = [];
  return {
    register(matcher, handler) {
      routes.push({ matcher, handler });
    },
    handleUpgrade(req, socket, head) {
      if (!req.url) {
        socket.destroy();
        return;
      }
      const url = new URL(req.url, "http://localhost");
      for (const route of routes) {
        const match = route.matcher(url.pathname);
        if (match) {
          route.handler(req, socket, head, match, url);
          return;
        }
      }
      socket.destroy();
    },
    bind(server) {
      server.on("upgrade", (req, socket, head) => this.handleUpgrade(req, socket, head));
    },
  };
}
