import { Message, ThreadSummary } from "../types";
import { Compressor } from "./interface";

/**
 * Default compressor. Returns an empty summary. The cache layer still
 * records that "messages up to id X have been considered" so callers can
 * distinguish "uncompressed because Noop" from "needs compression."
 *
 * Coverage extends the previous summary's covered set rather than
 * replacing it — otherwise repeated threshold crossings would lose track
 * of older messages and re-trigger compression indefinitely.
 */
export class NoopCompressor implements Compressor {
  async compress(
    messages: Message[],
    prev?: ThreadSummary
  ): Promise<ThreadSummary> {
    return {
      text: "",
      decisions: [],
      openQuestions: [],
      artifacts: {},
      coversMessageIds: [
        ...(prev?.coversMessageIds ?? []),
        ...messages.map((m) => m.id),
      ],
      generatedAt: Date.now(),
    };
  }
}
