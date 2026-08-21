/**
 * Interpreting a human's free-text reply to a gated-action prompt. Pure and
 * channel-agnostic so channels share one vocabulary and it stays unit-testable
 * (the CLI consumes it today; a future chat channel would too).
 */

const APPROVE = /^(y|yes|yep|yeah|approve|approved|ok|okay|sure|go ahead)\b/i;
const DENY = /^(n|no|nope|deny|denied|reject|rejected|stop|cancel)\b/i;

export type ApprovalReply = "approve" | "deny" | "unclear";

/**
 * "unclear" means neither clearly yes nor no — channels should re-prompt
 * rather than silently treating a "Yes please" typo as a denial.
 */
export function classifyApprovalReply(input: string): ApprovalReply {
  const text = input.trim();
  if (APPROVE.test(text)) return "approve";
  if (DENY.test(text)) return "deny";
  return "unclear";
}
