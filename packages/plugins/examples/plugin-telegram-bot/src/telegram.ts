/**
 * Telegram Bot API types and helpers.
 *
 * Minimal subset of the Telegram Bot API types needed for our plugin.
 * We call the API via ctx.http.fetch rather than a library dependency.
 */

import { TELEGRAM_API_BASE } from "./constants.js";
import type { PluginHttpClient, PluginLogger } from "@paperclipai/plugin-sdk";

// ---------------------------------------------------------------------------
// Telegram types (subset)
// ---------------------------------------------------------------------------

export interface TelegramUser {
  id: number;
  is_bot: boolean;
  first_name: string;
  last_name?: string;
  username?: string;
}

export interface TelegramChat {
  id: number;
  type: "private" | "group" | "supergroup" | "channel";
  title?: string;
  first_name?: string;
  last_name?: string;
  username?: string;
}

export interface TelegramMessage {
  message_id: number;
  from?: TelegramUser;
  chat: TelegramChat;
  date: number;
  text?: string;
  voice?: TelegramVoice;
  entities?: TelegramMessageEntity[];
}

export interface TelegramVoice {
  file_id: string;
  file_unique_id: string;
  duration: number;
  mime_type?: string;
  file_size?: number;
}

export interface TelegramMessageEntity {
  type: "bot_command" | "mention" | "text_link" | "url" | string;
  offset: number;
  length: number;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
  callback_query?: {
    id: string;
    from: TelegramUser;
    message?: TelegramMessage;
    data?: string;
  };
}

// ---------------------------------------------------------------------------
// Telegram Bot API client
// ---------------------------------------------------------------------------

export interface TelegramFile {
  file_id: string;
  file_unique_id: string;
  file_size?: number;
  file_path?: string;
}

export interface TelegramClient {
  sendMessage(chatId: number | string, text: string, options?: SendMessageOptions): Promise<void>;
  sendVoice(chatId: number | string, audio: Uint8Array, options?: SendVoiceOptions): Promise<void>;
  sendChatAction(chatId: number | string, action: string): Promise<void>;
  getUpdates(offset?: number, timeout?: number): Promise<TelegramUpdate[]>;
  deleteWebhook(): Promise<void>;
  /** Get file metadata (including file_path for download). */
  getFile(fileId: string): Promise<TelegramFile>;
  /** Download a file's content as bytes. */
  downloadFile(filePath: string): Promise<Uint8Array>;
}

export interface SendVoiceOptions {
  caption?: string;
  parse_mode?: "HTML" | "MarkdownV2";
  duration?: number;
}

export interface SendMessageOptions {
  parse_mode?: "HTML" | "MarkdownV2";
  disable_web_page_preview?: boolean;
  reply_to_message_id?: number;
}

export function createTelegramClient(
  http: PluginHttpClient,
  logger: PluginLogger,
  botToken: string,
): TelegramClient {
  const baseUrl = `${TELEGRAM_API_BASE}/bot${botToken}`;

  async function callApi(method: string, body: Record<string, unknown>): Promise<unknown> {
    const response = await http.fetch(`${baseUrl}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    const data = (await response.json()) as { ok: boolean; description?: string; result?: unknown };

    if (!data.ok) {
      logger.error(`Telegram API error on ${method}`, {
        description: data.description,
        status: response.status,
      });
      throw new Error(`Telegram API ${method} failed: ${data.description ?? "unknown error"}`);
    }

    return data.result;
  }

  return {
    async sendMessage(chatId, text, options) {
      // Telegram has a 4096 char limit per message. Chunk if needed.
      const chunks = chunkText(text, 4000);
      for (const chunk of chunks) {
        await callApi("sendMessage", {
          chat_id: chatId,
          text: chunk,
          parse_mode: options?.parse_mode,
          disable_web_page_preview: options?.disable_web_page_preview,
          reply_to_message_id: options?.reply_to_message_id,
        });
      }
    },

    async sendVoice(chatId, audio, options) {
      const formData = new FormData();
      formData.append("chat_id", String(chatId));
      const audioBuffer = audio.buffer.slice(audio.byteOffset, audio.byteOffset + audio.byteLength) as ArrayBuffer;
      formData.append("voice", new Blob([audioBuffer], { type: "audio/ogg" }), "briefing.ogg");
      if (options?.caption) formData.append("caption", options.caption);
      if (options?.parse_mode) formData.append("parse_mode", options.parse_mode);
      if (options?.duration) formData.append("duration", String(options.duration));

      // Global fetch, NOT ctx.http: the host RPC bridge stringifies bodies
      // (FormData becomes "[object FormData]"), so multipart uploads must
      // bypass the bridge (FRE-1318).
      const response = await fetch(`${baseUrl}/sendVoice`, {
        method: "POST",
        body: formData,
      });

      const data = (await response.json()) as { ok: boolean; description?: string };
      if (!data.ok) {
        logger.error("Telegram sendVoice failed", { description: data.description });
        throw new Error(`Telegram sendVoice failed: ${data.description ?? "unknown error"}`);
      }
    },

    async sendChatAction(chatId, action) {
      await callApi("sendChatAction", {
        chat_id: chatId,
        action,
      });
    },

    async getUpdates(offset, timeout = 0) {
      const params: Record<string, unknown> = {
        allowed_updates: ["message", "edited_message", "callback_query"],
      };
      if (offset !== undefined) params.offset = offset;
      if (timeout > 0) params.timeout = timeout;

      const result = await callApi("getUpdates", params);
      return (result as TelegramUpdate[]) ?? [];
    },

    async deleteWebhook() {
      await callApi("deleteWebhook", {});
      logger.info("Telegram webhook deleted (switching to polling mode)");
    },

    async getFile(fileId) {
      const result = await callApi("getFile", { file_id: fileId });
      return result as TelegramFile;
    },

    async downloadFile(filePath) {
      const url = `${TELEGRAM_API_BASE}/file/bot${botToken}/${filePath}`;
      // Global fetch, NOT ctx.http: binary file content would be corrupted
      // by the bridge's UTF-8 string serialization (FRE-1318).
      const response = await fetch(url, { method: "GET" });
      if (!response.ok) {
        throw new Error(`Failed to download file: ${response.status}`);
      }
      const buffer = await response.arrayBuffer();
      return new Uint8Array(buffer);
    },
  };
}

// ---------------------------------------------------------------------------
// Parsing helpers
// ---------------------------------------------------------------------------

/** Extract the bot command and arguments from a message. */
export function parseCommand(message: TelegramMessage): { command: string; args: string } | null {
  if (!message.text || !message.entities) return null;

  const commandEntity = message.entities.find((e) => e.type === "bot_command" && e.offset === 0);
  if (!commandEntity) return null;

  const rawCommand = message.text.slice(commandEntity.offset, commandEntity.offset + commandEntity.length);
  // Strip @botname suffix if present (e.g., /start@MyBot -> /start)
  const command = rawCommand.split("@")[0]!.toLowerCase();
  const args = message.text.slice(commandEntity.offset + commandEntity.length).trim();

  return { command, args };
}

/** Check if a chat ID is in the allowlist. Empty allowlist means all are allowed. */
export function isChatAllowed(chatId: number, allowedChatIds: string): boolean {
  if (!allowedChatIds.trim()) return true;
  const allowed = allowedChatIds.split(",").map((id) => id.trim());
  return allowed.includes(String(chatId));
}

/** Chunk text into segments under maxLen, splitting at newlines when possible. */
function chunkText(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }

    // Find the last newline within the limit
    let splitAt = remaining.lastIndexOf("\n", maxLen);
    if (splitAt <= 0) splitAt = maxLen;

    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).replace(/^\n/, "");
  }

  return chunks;
}

/** Escape special characters for Telegram MarkdownV2. */
export function escapeMarkdownV2(text: string): string {
  return text.replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, "\\$1");
}

/** Format text as HTML for Telegram (simpler escaping). */
export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
