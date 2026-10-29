/**
 * The text of a tool result that is nothing but images.
 *
 * The images travel beside the text, as references on the message, and the
 * text says what the result was so it does not read as empty where only text
 * is shown. A view that draws the images has no use for it: shown next to
 * them, it is a tag repeating what is on screen. One function makes the
 * text and recognises it, so the two cannot drift apart.
 */
export function imageOnlyResultText(count: number): string {
  return count === 1 ? '[image]' : `[${count} images]`;
}
