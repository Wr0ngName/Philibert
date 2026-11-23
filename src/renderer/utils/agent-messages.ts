/**
 * Messages the main conversation left a running agent (SendMessage), until
 * the agent reads them.
 *
 * A message to a running agent waits for the agent's next tool round, as a
 * prompt sent into a busy discussion waits for Claude's next step. Until then
 * it is nowhere in the agent's transcript: the agent's view showed nothing of
 * it, where the discussion shows such a prompt above the composer. Once read,
 * the CLI records it in the transcript (CLI 2.1.280: a `queued_command`
 * attachment, its prompt the message's text — messagesSentToAgent), where the
 * view shows it as a message.
 */

import type { ChatMessage } from '@shared/types';

export interface MessageToAgent {
  /** The SendMessage call's tool_use block id. */
  id: string;
  /** The agent it was left for: its task's id. */
  agentId: string;
  /** The message, as the call sent it and the agent reads it. */
  content: string;
  /** When the call was made, by the app's clock. */
  sentAt: number;
}

/**
 * How much earlier than its call a message's reading may be stamped. Both
 * are this machine's clock, but the call's time is when the app was told of
 * it, after the CLI had queued the message — and an agent between two tool
 * calls reads it at once.
 */
const CLOCK_SLACK_MS = 2_000;

/**
 * Of the messages left for an agent, those its transcript does not have yet,
 * oldest first.
 *
 * Read is the transcript holding it: a message from the main conversation
 * (`user`) with its text, from no earlier than it was sent. Each of the
 * transcript's messages accounts for one sent message only, so the same text
 * sent twice is read twice.
 */
export function unreadMessagesToAgent(sent: MessageToAgent[], transcript: ChatMessage[]): MessageToAgent[] {
  const received = transcript.filter((message) => message.role === 'user');
  const used = new Set<ChatMessage>();
  return [...sent]
    .sort((a, b) => a.sentAt - b.sentAt)
    .filter((message) => {
      const reading = received.find((candidate) => !used.has(candidate)
        && candidate.content.trim() === message.content.trim()
        && candidate.timestamp >= message.sentAt - CLOCK_SLACK_MS);
      if (reading) used.add(reading);
      return !reading;
    });
}
