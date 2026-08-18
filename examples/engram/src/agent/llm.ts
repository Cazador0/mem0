import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";

/**
 * The single LLM seam. Every call returns a Zod-validated object: the LLM
 * proposes, code disposes (constitution IV). Injected as an interface so tests
 * run a ScriptedLLM with zero network.
 *
 * Server-side refusal fallbacks (`fallbacks: "default"` + its beta header) are
 * ON by default for Opus-tier models — disable with ENGRAM_FALLBACKS=off.
 */
export interface StructuredRequest<T> {
  system: string;
  user: string;
  schema: z.ZodType<T>;
  schemaName: string;
}

export interface LLMClient {
  structured<T>(req: StructuredRequest<T>): Promise<T>;
}

export class LLMError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "LLMError";
  }
}

export class RefusalError extends LLMError {
  constructor(
    readonly category: string | null,
    readonly explanation: string | null,
  ) {
    super(`model declined the request${category ? ` (category: ${category})` : ""}`);
    this.name = "RefusalError";
  }
}

const MAX_PARSE_RETRIES = 2;

export class AnthropicLLM implements LLMClient {
  private lazyClient: Anthropic | undefined;

  constructor(
    private readonly model: string,
    private readonly useFallbacks: boolean,
    client?: Anthropic,
  ) {
    this.lazyClient = client;
  }

  /** Constructed on first use so the server can boot without credentials. */
  private get client(): Anthropic {
    this.lazyClient ??= new Anthropic();
    return this.lazyClient;
  }

  async structured<T>(req: StructuredRequest<T>): Promise<T> {
    const jsonSchema = z.toJSONSchema(req.schema);
    const system =
      `${req.system}\n\n# Output format\n` +
      `Respond with a single JSON object named "${req.schemaName}" matching this JSON Schema exactly — ` +
      `no prose before or after, no code fences:\n${JSON.stringify(jsonSchema)}`;

    const messages: Anthropic.MessageParam[] = [{ role: "user", content: req.user }];

    for (let attempt = 0; ; attempt++) {
      const text = await this.callModel(system, messages);
      const salvaged = extractJson(text);
      const parsed = salvaged === null ? null : req.schema.safeParse(salvaged);
      if (parsed?.success) return parsed.data;

      const problem =
        salvaged === null
          ? "your reply contained no parseable JSON object"
          : `your JSON failed validation: ${parsed ? summarizeZodError(parsed.error) : "unknown"}`;
      if (attempt >= MAX_PARSE_RETRIES) {
        throw new LLMError(`structured output failed after ${attempt + 1} attempts: ${problem}`);
      }
      messages.push(
        { role: "assistant", content: text || "(empty)" },
        { role: "user", content: `That was invalid: ${problem}. Return ONLY the corrected JSON object.` },
      );
    }
  }

  private async callModel(system: string, messages: Anthropic.MessageParam[]): Promise<string> {
    try {
      if (this.useFallbacks) {
        const response = await this.client.beta.messages.create({
          model: this.model,
          max_tokens: 16000,
          thinking: { type: "adaptive" },
          betas: ["server-side-fallback-2026-07-01"],
          fallbacks: "default",
          system,
          messages,
        } as Parameters<typeof this.client.beta.messages.create>[0]);
        return textOf(response as unknown as Anthropic.Message);
      }
      const response = await this.client.messages.create({
        model: this.model,
        max_tokens: 16000,
        thinking: { type: "adaptive" },
        system,
        messages,
      });
      return textOf(response);
    } catch (err) {
      if (err instanceof RefusalError || err instanceof LLMError) throw err;
      if (err instanceof Anthropic.APIError) {
        throw new LLMError(`Anthropic API error ${err.status}: ${err.message}`, { cause: err });
      }
      throw new LLMError(`LLM call failed: ${(err as Error).message}`, { cause: err });
    }
  }
}

function textOf(response: Anthropic.Message): string {
  if (response.stop_reason === "refusal") {
    const details = response.stop_details as { category?: string | null; explanation?: string | null } | null;
    throw new RefusalError(details?.category ?? null, details?.explanation ?? null);
  }
  return response.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map(block => block.text)
    .join("");
}

/** Salvage parser (mem0's extract_json pattern): strip fences, slice outermost braces. */
export function extractJson(text: string): unknown | null {
  const stripped = text.replace(/```(?:json)?/g, "").trim();
  const start = stripped.indexOf("{");
  const end = stripped.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(stripped.slice(start, end + 1));
  } catch {
    return null;
  }
}

function summarizeZodError(error: z.ZodError): string {
  return error.issues
    .slice(0, 3)
    .map(issue => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("; ");
}
