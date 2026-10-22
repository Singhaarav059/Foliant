// Names for the colour swatches the tools offer, so a screen reader says
// "Red" rather than "#d33f6a" (dictionary keys color.<name>).
const NAMES: Record<string, string> = {
  "#111827": "black", "#1f2937": "black", "#d33f6a": "red", "#b91c1c": "red", "#2f6fed": "blue", "#1d4ed8": "blue",
  "#12a37f": "green", "#e2662b": "orange", "#7b4fe0": "purple", "#ffffff": "white",
};
export const colorKey = (hex: string) => `color.${NAMES[hex.toLowerCase()] ?? "custom"}`;
