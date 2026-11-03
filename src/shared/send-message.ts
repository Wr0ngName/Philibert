/**
 * SendMessage, the tool the main conversation writes to a running agent with.
 *
 * Its input, as the CLI describes it (2.1.280):
 *  - `to`: "a background agent's name or agentId, a teammate name, or
 *    'main'". The agentId is the id its task has, as the Agent call's result
 *    gives it ("agentId: a481e4eafefca67f3"); the name is the one the Agent
 *    call gave it in its `name`. A description is not a name: `to: "waiter"`
 *    for an agent only described as "waiter" was refused with "No agent
 *    named 'waiter' is reachable". The CLI repeats `to` in `recipient`.
 *  - `message`: the text, or a structured request.
 *  - `summary`: "A 5-10 word summary shown as a one-line preview in the UI.
 *    Defaults to the first line of a plain-text message".
 */

export const SEND_MESSAGE_TOOL = 'SendMessage';

/** The input fields that hold the addressed agent's id or name. */
const ADDRESS_FIELDS = ['to', 'recipient'] as const;

/**
 * Who a SendMessage call addresses — an agent's id or name — and the input
 * fields that hold it; null for any other tool, or a call with no address.
 */
export function sendMessageAddress(
  toolName: string,
  input: Record<string, unknown> | null | undefined,
): { address: string; fields: string[] } | null {
  if (toolName !== SEND_MESSAGE_TOOL || !input) return null;
  const address = input.to;
  if (typeof address !== 'string' || !address) return null;
  return { address, fields: ADDRESS_FIELDS.filter((field) => input[field] === address) };
}

/**
 * The call's one-line preview, as the CLI defines it: its summary, else the
 * first line of a plain-text message. Empty for a structured message
 * without a summary.
 */
export function sendMessagePreview(input: Record<string, unknown>): string {
  const summary = typeof input.summary === 'string' ? input.summary.trim() : '';
  if (summary) return summary;
  const message = typeof input.message === 'string' ? input.message : '';
  return message.trim().split('\n')[0].trim();
}
