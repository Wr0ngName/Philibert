/**
 * Separating a tool result's images from its text.
 *
 * The shapes asserted here are taken from the installed SDK type definitions
 * rather than invented: `ImageBlockParam` with a `Base64ImageSource`
 * (@anthropic-ai/sdk messages.d.ts) for the model-facing content, and the
 * Read tool's `{ type:'image', file:{ base64, type, dimensions } }`
 * (claude-agent-sdk sdk-tools.d.ts) for the structured companion.
 *
 * Both are untrusted: whatever the model's tools produced ends up here.
 */

import { describe, it, expect } from 'vitest';

import { toolResultParts } from '../tool-result-images';

const DATA = 'aGVsbG8=';
const OTHER = 'd29ybGQ=';

/** The model-facing block, exactly as the Messages API shapes it. */
function imageBlock(data = DATA, mediaType = 'image/png') {
  return { type: 'image', source: { type: 'base64', media_type: mediaType, data } };
}

/** The Read tool's structured output for an image file. */
function readResult(data = DATA, type = 'image/png', dimensions?: unknown) {
  return { type: 'image', file: { base64: data, type, originalSize: 1234, dimensions } };
}

describe('splitting a tool result into text and images', () => {
  it('keeps a plain string result exactly as it is', () => {
    expect(toolResultParts('just text')).toEqual({ text: 'just text', images: [] });
  });

  it('takes the image out of the model-facing content', () => {
    const parts = toolResultParts([{ type: 'text', text: 'here it is' }, imageBlock()]);

    expect(parts.images).toEqual([{ base64: DATA, mediaType: 'image/png' }]);
    expect(parts.text).toBe('here it is');
  });

  it('no longer turns an image into an empty string', () => {
    // The defect this exists to fix: the text was built with
    // `blocks.map(b => b.text || '')`, so an image contributed '' and a Read
    // of a .png showed a blank result with nothing to say why.
    const parts = toolResultParts([imageBlock()]);

    expect(parts.images).toHaveLength(1);
    expect(parts.text).toBe('[image]');
    expect(parts.text).not.toBe('');
  });

  it('says how many when a result is nothing but images', () => {
    const parts = toolResultParts([imageBlock(DATA), imageBlock(OTHER)]);

    expect(parts.images).toHaveLength(2);
    expect(parts.text).toBe('[2 images]');
  });

  it('takes the image off the structured Read result', () => {
    const parts = toolResultParts('Read 1 image', readResult());

    expect(parts.images).toEqual([{ base64: DATA, mediaType: 'image/png' }]);
    expect(parts.text).toBe('Read 1 image');
  });

  it('carries the dimensions the Read result reports', () => {
    const parts = toolResultParts('', readResult(DATA, 'image/png', {
      originalWidth: 1920, originalHeight: 1080, displayWidth: 960, displayHeight: 540,
    }));

    expect(parts.images[0]).toEqual({
      base64: DATA, mediaType: 'image/png', width: 1920, height: 1080,
    });
  });

  it('keeps one copy when both paths carry the same image', () => {
    // A Read of an image puts it in both places. Stored twice it would cost
    // twice the disk and show twice in the transcript.
    const parts = toolResultParts([imageBlock(DATA)], readResult(DATA));

    expect(parts.images).toHaveLength(1);
  });

  it('keeps both when the two paths carry different images', () => {
    const parts = toolResultParts([imageBlock(DATA)], readResult(OTHER));

    expect(parts.images.map((i) => i.base64)).toEqual([DATA, OTHER]);
  });

  it('ignores a media type the API does not accept', () => {
    // Counting it would make the text promise an image the transcript then
    // cannot show, because the store refuses the same types.
    const parts = toolResultParts([
      { type: 'text', text: 'a diagram' },
      imageBlock(DATA, 'image/svg+xml'),
    ]);

    expect(parts.images).toHaveLength(0);
    expect(parts.text).toBe('a diagram');
  });

  it('survives shapes that are not what they claim', () => {
    // Everything here reaches us from whatever a tool produced.
    const nonsense: unknown[] = [
      null,
      undefined,
      42,
      { type: 'image' },
      { type: 'image', source: null },
      { type: 'image', source: { type: 'url', url: 'http://x/y.png' } },
      { type: 'image', source: { type: 'base64', media_type: 'image/png' } },
      { type: 'image', source: { type: 'base64', data: DATA } },
      [{ type: 'image', source: { type: 'base64', media_type: 5, data: DATA } }],
      [null, undefined, 7],
    ];

    for (const value of nonsense) {
      const parts = toolResultParts(value);
      expect(parts.images, JSON.stringify(value)).toEqual([]);
      expect(typeof parts.text).toBe('string');
    }
  });

  it('ignores a structured result that is not an image', () => {
    const parts = toolResultParts('done', { type: 'text', file: { base64: DATA } });
    expect(parts.images).toEqual([]);

    const empty = toolResultParts('done', readResult(''));
    expect(empty.images).toEqual([]);
  });

  it('still stringifies a structured non-array result, as before', () => {
    expect(toolResultParts({ ok: true }).text).toBe('{"ok":true}');
    expect(toolResultParts(undefined).text).toBe('');
  });
});
