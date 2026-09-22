export const MANAGED_RULE_MARKER = "[openclaw-firefly:managed:v1]";

export type ManagedMarkerVersion = "managed:v1" | "pending:v1" | "confirmed:v1";

export interface ManagedDescription {
  marker: ManagedMarkerVersion;
  userDescription: string;
}

// Markers are deliberately recognized only on the first line. Legacy metadata is
// opaque: it identifies a managed rule but has no bearing on its current contents.
const MANAGED_MARKER = /^\[openclaw-firefly:(?:managed:v1|pending:v1(?:;[^\]\r\n]*)?|confirmed:v1(?:;[^\]\r\n]*)?)\](?:\r?\n|$)/u;

export function parseManagedDescription(description: string | null | undefined): ManagedDescription | null {
  if (description === null || description === undefined) return null;
  const match = MANAGED_MARKER.exec(description);
  if (match === null) return null;
  const marker: ManagedMarkerVersion = description.startsWith("[openclaw-firefly:managed:v1]")
    ? "managed:v1"
    : description.startsWith("[openclaw-firefly:pending:v1")
      ? "pending:v1"
      : "confirmed:v1";
  return { marker, userDescription: description.slice(match[0].length) };
}

export function formatManagedDescription(userDescription?: string): string {
  const description = userDescription ?? "";
  return description === "" ? MANAGED_RULE_MARKER : `${MANAGED_RULE_MARKER}\n${description}`;
}
