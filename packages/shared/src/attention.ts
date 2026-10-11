export const ATTENTION_COLORS = {
  red: "#dc2626",
  blue: "#2563eb",
  green: "#16a34a",
  yellow: "#eab308",
  orange: "#ea580c",
  purple: "#9333ea",
  pink: "#db2777",
  cyan: "#0891b2",
} as const;
/** Explicit bounded color phrases, shared by every domain and general attention. */
export function parseAttentionColor(text: string): {
  color?: string;
  error?: string;
} {
  const match = text
    .toLowerCase()
    .match(
      /\b(?:in|colou?red|with (?:the )?colou?r)\s+(?:the colou?r\s+)?(#[a-z0-9]+|[a-z]+)\s*[.!?]?$/,
    );
  if (!match) return {};
  const value = match[1]!;
  if (/^#(?:[a-f0-9]{3}|[a-f0-9]{6})$/.test(value)) return { color: value };
  const color = ATTENTION_COLORS[value as keyof typeof ATTENTION_COLORS];
  return color
    ? { color }
    : {
        error:
          "Choose red, blue, green, yellow, orange, purple, pink, cyan, or a valid hex color.",
      };
}
