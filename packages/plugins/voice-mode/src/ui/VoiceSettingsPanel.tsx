/**
 * VoiceSettingsPanel — Plugin settings page for per-agent voice assignment.
 *
 * Slot type: settingsPage (PluginSettingsPageProps)
 *
 * Agent enumeration note: PluginCommentAnnotationProps / PluginHostContext do
 * not expose an agent list. The host does not provide a "list agents" action
 * via the plugin SDK. This panel therefore uses a manual JSON mapping approach:
 * the user pastes { "agentId": "voiceId" } JSON, which is merged into the KV
 * store. A per-known-entry select UI is also rendered for any agent IDs already
 * persisted in the store.
 *
 * When the host SDK exposes agent enumeration, replace the textarea with a
 * proper per-agent select list.
 */
import React, { useEffect, useState, useCallback } from "react";
import { usePluginAction } from "@paperclipai/plugin-sdk/ui";
import type { PluginSettingsPageProps } from "@paperclipai/plugin-sdk/ui";
import { VOICE_CATALOG, KENN_VOICE_ID } from "../shared/voices";

type AgentVoiceMap = Record<string, string>;

// Shared button/input style tokens matching VoiceComposerControls pattern
const inputStyle: React.CSSProperties = {
  fontFamily: "inherit",
  fontSize: "0.875rem",
  padding: "0.375rem 0.5rem",
  border: "1px solid var(--color-border, #d1d5db)",
  borderRadius: "0.375rem",
  background: "var(--color-surface, #fff)",
  color: "inherit",
  width: "100%",
  boxSizing: "border-box",
};

const labelStyle: React.CSSProperties = {
  display: "block",
  fontSize: "0.75rem",
  fontWeight: 600,
  marginBottom: "0.25rem",
  color: "var(--color-muted, #6b7280)",
  textTransform: "uppercase",
  letterSpacing: "0.05em",
};

const sectionStyle: React.CSSProperties = {
  display: "grid",
  gap: "0.75rem",
  padding: "1rem",
  border: "1px solid var(--color-border, #e5e7eb)",
  borderRadius: "0.5rem",
  background: "var(--color-surface, #fff)",
};

export function VoiceSettingsPanel(_props: PluginSettingsPageProps) {
  const getAgentVoices = usePluginAction("voice.agentVoices.get");
  const setAgentVoice = usePluginAction("voice.agentVoices.set");

  const [voiceMap, setVoiceMap] = useState<AgentVoiceMap>({});
  const [jsonInput, setJsonInput] = useState<string>("");
  const [jsonError, setJsonError] = useState<string>("");
  const [saveStatus, setSaveStatus] = useState<string>("");
  const [loading, setLoading] = useState(true);

  // Load current map on mount
  useEffect(() => {
    setLoading(true);
    getAgentVoices({})
      .then((raw) => {
        const map = (raw ?? {}) as AgentVoiceMap;
        setVoiceMap(map);
        setJsonInput(JSON.stringify(map, null, 2));
      })
      .catch(() => {
        setVoiceMap({});
        setJsonInput("{}");
      })
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Update a single agent's voice via select dropdown
  const handleSelectChange = useCallback(
    async (agentId: string, newVoiceId: string) => {
      try {
        setSaveStatus("Saving...");
        await setAgentVoice({ agentId, voiceId: newVoiceId });
        setVoiceMap((prev) => ({ ...prev, [agentId]: newVoiceId }));
        setSaveStatus("Saved.");
        setTimeout(() => setSaveStatus(""), 2000);
      } catch {
        setSaveStatus("Error saving.");
      }
    },
    [setAgentVoice],
  );

  // Apply JSON blob from textarea — merges all entries into KV store
  const handleApplyJson = useCallback(async () => {
    setJsonError("");
    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonInput);
    } catch {
      setJsonError("Invalid JSON.");
      return;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      setJsonError("Expected a JSON object mapping agentId -> voiceId.");
      return;
    }
    const entries = Object.entries(parsed as Record<string, unknown>);
    setSaveStatus("Saving...");
    try {
      for (const [agentId, voiceId] of entries) {
        if (typeof voiceId !== "string") continue;
        await setAgentVoice({ agentId, voiceId });
      }
      // Reload from store
      const fresh = (await getAgentVoices({})) as AgentVoiceMap;
      setVoiceMap(fresh ?? {});
      setSaveStatus("Saved.");
      setTimeout(() => setSaveStatus(""), 2000);
    } catch {
      setSaveStatus("Error saving one or more entries.");
    }
  }, [jsonInput, setAgentVoice, getAgentVoices]);

  return (
    <div
      style={{ display: "grid", gap: "1.5rem", padding: "1.5rem", maxWidth: "36rem" }}
      className="voice-settings-panel"
    >
      <div>
        <h2 style={{ margin: 0, fontSize: "1rem", fontWeight: 700 }}>Voice Mode Settings</h2>
        <p style={{ margin: "0.25rem 0 0", fontSize: "0.875rem", color: "var(--color-muted, #6b7280)" }}>
          Assign ElevenLabs voices to agents. The default voice is Kenn Akomea.
        </p>
      </div>

      {/* Per-agent selects for already-stored entries */}
      {!loading && Object.keys(voiceMap).length > 0 && (
        <div style={sectionStyle}>
          <p style={{ margin: 0, ...labelStyle }}>Stored Agent Voice Assignments</p>
          {Object.entries(voiceMap).map(([agentId, currentVoiceId]) => (
            <div key={agentId} style={{ display: "grid", gap: "0.25rem" }}>
              <label htmlFor={`voice-select-${agentId}`} style={labelStyle}>
                Agent: {agentId}
              </label>
              <select
                id={`voice-select-${agentId}`}
                value={currentVoiceId}
                onChange={(e) => void handleSelectChange(agentId, e.target.value)}
                style={inputStyle}
              >
                {VOICE_CATALOG.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.label}
                  </option>
                ))}
                {/* Preserve unlisted voice IDs */}
                {!VOICE_CATALOG.some((v) => v.id === currentVoiceId) && (
                  <option value={currentVoiceId}>{currentVoiceId} (custom)</option>
                )}
              </select>
            </div>
          ))}
          {saveStatus && (
            <p style={{ margin: 0, fontSize: "0.75rem", color: "var(--color-muted, #6b7280)" }}>
              {saveStatus}
            </p>
          )}
        </div>
      )}

      {/* Manual JSON mapping — primary method until host exposes agent enumeration */}
      <div style={sectionStyle}>
        <div>
          <p style={{ margin: 0, ...labelStyle }}>Bulk Assign via JSON</p>
          <p style={{ margin: "0.25rem 0 0", fontSize: "0.8rem", color: "var(--color-muted, #6b7280)" }}>
            Paste a JSON object mapping agent IDs to voice IDs. Merges with existing assignments.
          </p>
        </div>
        <textarea
          rows={6}
          value={jsonInput}
          onChange={(e) => {
            setJsonInput(e.target.value);
            setJsonError("");
          }}
          placeholder={`{\n  "agent-uuid-here": "${KENN_VOICE_ID}"\n}`}
          style={{ ...inputStyle, resize: "vertical", fontFamily: "monospace" }}
          aria-label="Agent voice JSON mapping"
        />
        {jsonError && (
          <p style={{ margin: 0, fontSize: "0.75rem", color: "var(--color-error, #ef4444)" }}>
            {jsonError}
          </p>
        )}
        <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
          <button
            type="button"
            onClick={() => void handleApplyJson()}
            style={{
              padding: "0.375rem 0.75rem",
              background: "var(--color-accent, #3b82f6)",
              color: "#fff",
              border: "none",
              borderRadius: "0.375rem",
              cursor: "pointer",
              fontSize: "0.875rem",
              fontWeight: 600,
            }}
          >
            Apply
          </button>
          {saveStatus && (
            <span style={{ fontSize: "0.75rem", color: "var(--color-muted, #6b7280)" }}>
              {saveStatus}
            </span>
          )}
        </div>
        <div>
          <p style={{ margin: 0, ...labelStyle }}>Available Voice IDs</p>
          <ul style={{ margin: "0.25rem 0 0", paddingLeft: "1.25rem", fontSize: "0.8rem" }}>
            {VOICE_CATALOG.map((v) => (
              <li key={v.id}>
                <code>{v.id}</code> — {v.label}
              </li>
            ))}
          </ul>
        </div>
      </div>

      {loading && (
        <p style={{ fontSize: "0.875rem", color: "var(--color-muted, #6b7280)" }}>
          Loading current settings...
        </p>
      )}
    </div>
  );
}
