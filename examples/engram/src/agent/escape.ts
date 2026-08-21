/**
 * Neutralize angle brackets in untrusted text before it enters a prompt.
 *
 * Every surface that interpolates stored text into the XML-ish rendering shares
 * this one function — render.ts (event data), prefetch.ts (recalled memories),
 * core.ts (self-edited blocks) — so a new surface cannot quietly ship its own
 * slightly-different copy.
 *
 * Deliberately does NOT escape `&`: the goal is that no tag can be
 * reconstructed, not round-trip fidelity. The cost is that a human who literally
 * types "&lt;" reads the same as an escaped "<" (see CoreMemory.replace, which
 * compensates on the write side).
 */
export function escapeAngleBrackets(text: string): string {
  return text.replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Inverse of the above, for matching model-supplied text against raw storage. */
export function unescapeAngleBrackets(text: string): string {
  return text.replace(/&lt;/g, "<").replace(/&gt;/g, ">");
}
