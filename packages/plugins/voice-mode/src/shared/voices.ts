/**
 * Voice catalog for the Voice Mode plugin.
 *
 * KENN_VOICE_ID is the default voice (Kenn Akomea, Black British, calm & friendly).
 * VOICE_CATALOG lists all available ElevenLabs voices for per-agent assignment.
 */

export const KENN_VOICE_ID = "VjSFSNiy9sK85Z9QRu3d";

export const VOICE_CATALOG: Array<{ id: string; label: string }> = [
  { id: KENN_VOICE_ID, label: "Kenn Akomea (default)" },
  { id: "21m00Tcm4TlvDq8ikWAM", label: "Rachel" },
  { id: "AZnzlk1XvdvUeBnXmlld", label: "Domi" },
  { id: "ErXwobaYiN019PkySvjV", label: "Antoni" },
];
