/**
 * Pulling images out of a tool result.
 *
 * The CLI delivers an image two ways, and which one carries it depends on the
 * tool — so both are read, and anything found twice is kept once:
 *
 *  - in the model-facing `tool_result.content`, as an Anthropic Messages API
 *    image block, `{ type:'image', source:{ type:'base64', media_type, data } }`.
 *    This is how rendered PDF pages arrive: sdk-tools.d.ts says the page image
 *    bytes are "delivered solely as image blocks in the model-facing
 *    tool_result content and are not retained on the tool_use_result".
 *  - on `SDKUserMessage.tool_use_result`, the structured companion, which for
 *    a Read of an image file is
 *    `{ type:'image', file:{ base64, type, originalSize, dimensions? } }`
 *    (sdk-tools.d.ts ReadOutput).
 *
 * Before this existed, the text of a tool result was built with
 * `blocks.map(b => b.text || '')`, so an image block contributed an empty
 * string: reading a .png showed a blank result, with nothing to say an image
 * had been there at all.
 */

import { IMAGE_MEDIA_TYPES } from '../../../shared/types';

export interface ExtractedImage {
  base64: string;
  mediaType: string;
  width?: number;
  height?: number;
}

/** What a tool result amounts to once its images are separated from its text. */
export interface ToolResultParts {
  /** The text blocks, joined — no longer silently including empties for images. */
  text: string;
  images: ExtractedImage[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** An Anthropic Messages API base64 image block, if this is one. */
function fromContentBlock(block: unknown): ExtractedImage | null {
  if (!isRecord(block) || block.type !== 'image') return null;
  const source = block.source;
  if (!isRecord(source) || source.type !== 'base64') return null;
  if (typeof source.data !== 'string' || typeof source.media_type !== 'string') return null;
  return { base64: source.data, mediaType: source.media_type };
}

/** The Read tool's structured image output, if this is one. */
function fromToolUseResult(result: unknown): ExtractedImage | null {
  if (!isRecord(result) || result.type !== 'image') return null;
  const file = result.file;
  if (!isRecord(file)) return null;
  if (typeof file.base64 !== 'string' || typeof file.type !== 'string') return null;
  if (file.base64.length === 0) return null;

  const dimensions = isRecord(file.dimensions) ? file.dimensions : undefined;
  const width = typeof dimensions?.originalWidth === 'number' ? dimensions.originalWidth : undefined;
  const height = typeof dimensions?.originalHeight === 'number'
    ? dimensions.originalHeight
    : undefined;

  return {
    base64: file.base64,
    mediaType: file.type,
    ...(width ? { width } : {}),
    ...(height ? { height } : {}),
  };
}

/**
 * Split a tool result into the text it should display and the images it
 * carries.
 *
 * `content` is the model-facing `tool_result.content` — a string, an array of
 * blocks, or something else entirely; `toolUseResult` is the structured
 * companion. Neither is trusted to have a shape: both come from whatever the
 * model's tools produced.
 */
export function toolResultParts(content: unknown, toolUseResult?: unknown): ToolResultParts {
  const images: ExtractedImage[] = [];
  const seen = new Set<string>();

  const add = (image: ExtractedImage | null): void => {
    if (!image) return;
    // Only the media types the API accepts: an image the store would refuse
    // should not be counted here either, or the text would claim an image
    // the transcript never shows.
    if (!(IMAGE_MEDIA_TYPES as readonly string[]).includes(image.mediaType)) return;
    // The same image can arrive on both paths. Keyed on the data itself
    // rather than on position, because the two shapes order independently.
    if (seen.has(image.base64)) return;
    seen.add(image.base64);
    images.push(image);
  };

  let text: string;
  if (typeof content === 'string') {
    text = content;
  } else if (Array.isArray(content)) {
    const texts: string[] = [];
    for (const block of content) {
      const image = fromContentBlock(block);
      if (image) {
        add(image);
        continue;
      }
      if (isRecord(block) && typeof block.text === 'string') texts.push(block.text);
    }
    text = texts.join('');
  } else if (content === undefined || content === null) {
    text = '';
  } else {
    text = JSON.stringify(content);
  }

  add(fromToolUseResult(toolUseResult));

  // An image-only result would otherwise show as nothing at all. The caller
  // renders the images; this is what the text of the result says it is.
  if (text.trim().length === 0 && images.length > 0) {
    text = images.length === 1 ? '[image]' : `[${images.length} images]`;
  }

  return { text, images };
}
