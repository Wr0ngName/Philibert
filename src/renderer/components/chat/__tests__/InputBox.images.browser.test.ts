/**
 * Attaching a picture to a prompt, in a real browser.
 *
 * Everything that makes attaching work is a browser API that happy-dom either
 * lacks or fakes: `DataTransfer`, a real `File`, `ClipboardEvent`, and
 * `FileReader` producing a real base64 data URL. A test that stubs those is
 * testing its own stubs — the one thing worth knowing is whether a genuine
 * paste of a genuine PNG ends up as bytes the main process can store.
 *
 * `window.electron` is stood up because there is no IPC in a browser at all.
 * The component, the clipboard, the file reading and the encoding are real.
 *
 * Run with `npm run test:browser`.
 */

import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { describe, it, expect, beforeEach } from 'vitest';

import type { MessageImage } from '@shared/types';

import { useConversationsStore } from '../../../stores/conversations';
import { useFilesStore } from '../../../stores/files';
import { useSettingsStore } from '../../../stores/settings';
import InputBox from '../InputBox.vue';

/** A real 1×1 PNG, as bytes. */
const PNG_BYTES = Uint8Array.from(atob(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
), (c) => c.charCodeAt(0));

const CONV = 'conv-attach';

interface SavedImage { conversationId: string; base64: string; mediaType: string; label?: string }

/** The image store, as the main process would answer for it. */
function installIpc(options: { refuse?: boolean } = {}) {
  const saved: SavedImage[] = [];
  let next = 0;
  (window as unknown as { electron: unknown }).electron = {
    conversation: {
      saveImage: async (conversationId: string, input: SavedImage) => {
        saved.push({ ...input, conversationId });
        if (options.refuse) return null;
        next += 1;
        return {
          id: `img_${next}`,
          mediaType: input.mediaType as MessageImage['mediaType'],
          byteSize: PNG_BYTES.length,
          origin: 'user',
          ...(input.label ? { label: input.label } : {}),
        } satisfies MessageImage;
      },
      readImage: async () => null,
    },
    // Every listener useClaudeChat registers on mount. Missing one throws
    // during setup and the composer never renders at all.
    claude: {
      getSlashCommands: async () => [],
      ...Object.fromEntries([
        'onActiveModel', 'onActiveQueriesChange', 'onBackgroundTasksChanged', 'onChunk',
        'onDone', 'onError', 'onSessionId', 'onSessionPermissionsChanged', 'onSlashCommands',
        'onSubagentActivity', 'onSystemNote', 'onTaskNotification', 'onToolCapture',
        'onToolExecuted', 'onToolResult', 'onToolUse', 'onUsageUpdate', 'onUserTurnUuid',
      ].map((name) => [name, () => () => {}])),
    },
    config: { get: async () => ({}), set: async () => undefined, onChange: () => () => {} },
    auth: { onInvalidated: () => () => {} },
    // Dictation is not what this file is about, but the composer sets it up
    // on mount — so it gets a surface that answers rather than throws.
    speech: {
      getAvailability: async () => ({ available: false }),
      onModelProgress: () => () => {},
      transcribe: async () => ({ text: '' }),
    },
  };
  return { saved };
}

function pngFile(name = 'shot.png', type = 'image/png'): File {
  return new File([PNG_BYTES], name, { type });
}

async function settle(frames = 8): Promise<void> {
  for (let i = 0; i < frames; i += 1) {
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
  }
}

function transferWith(...files: File[]): DataTransfer {
  const transfer = new DataTransfer();
  for (const file of files) transfer.items.add(file);
  return transfer;
}

function mountComposer() {
  setActivePinia(createPinia());
  const settings = useSettingsStore();
  settings.config.apiKey = 'sk-ant-test';
  // The files store derives this from settings rather than owning it.
  settings.config.workingDirectory = '/home/user/project';
  expect(useFilesStore().hasWorkingDirectory).toBe(true);
  const conversations = useConversationsStore();
  conversations.currentConversationId = CONV;

  const host = document.createElement('div');
  document.body.appendChild(host);
  return mount(InputBox, { attachTo: host });
}

describe('attaching a picture to a prompt, for real', () => {
  beforeEach(() => {
    delete (window as unknown as { electron?: unknown }).electron;
  });

  it('turns a pasted image into stored bytes', async () => {
    const { saved } = installIpc();
    const wrapper = mountComposer();
    await settle();

    const textarea = wrapper.find('textarea').element;
    textarea.dispatchEvent(new ClipboardEvent('paste', {
      clipboardData: transferWith(pngFile()),
      bubbles: true,
      cancelable: true,
    }));
    await settle();

    // A real FileReader produced real base64 from a real File.
    expect(saved).toHaveLength(1);
    expect(saved[0].conversationId).toBe(CONV);
    expect(saved[0].mediaType).toBe('image/png');
    expect(saved[0].label).toBe('shot.png');
    expect(Uint8Array.from(atob(saved[0].base64), (c) => c.charCodeAt(0)))
      .toEqual(PNG_BYTES);

    // And the user can see it is attached.
    expect(wrapper.text()).toContain('shot.png');

    wrapper.unmount();
  });

  it('leaves an ordinary text paste alone', async () => {
    // Intercepting every paste would break pasting text, which is what the
    // composer is mostly for.
    const { saved } = installIpc();
    const wrapper = mountComposer();
    await settle();

    const transfer = new DataTransfer();
    transfer.setData('text/plain', 'some pasted text');
    const event = new ClipboardEvent('paste', {
      clipboardData: transfer, bubbles: true, cancelable: true,
    });
    wrapper.find('textarea').element.dispatchEvent(event);
    await settle();

    expect(saved).toHaveLength(0);
    expect(event.defaultPrevented).toBe(false);

    wrapper.unmount();
  });

  it('takes an image dropped onto the composer', async () => {
    const { saved } = installIpc();
    const wrapper = mountComposer();
    await settle();

    wrapper.find('textarea').element.dispatchEvent(new DragEvent('drop', {
      dataTransfer: transferWith(pngFile('dropped.png')),
      bubbles: true,
      cancelable: true,
    }));
    await settle();

    expect(saved).toHaveLength(1);
    expect(saved[0].label).toBe('dropped.png');

    wrapper.unmount();
  });

  it('refuses a file the API cannot take, and says which', async () => {
    const { saved } = installIpc();
    const wrapper = mountComposer();
    await settle();

    wrapper.find('textarea').element.dispatchEvent(new ClipboardEvent('paste', {
      clipboardData: transferWith(new File([PNG_BYTES], 'diagram.svg', { type: 'image/svg+xml' })),
      bubbles: true,
      cancelable: true,
    }));
    await settle();

    // Never offered to the store at all.
    expect(saved).toHaveLength(0);
    expect(wrapper.text()).toContain('diagram.svg');
    expect(wrapper.text()).toContain('not a PNG');

    wrapper.unmount();
  });

  it('says so when the store will not keep the image', async () => {
    // Over the size limit, say. Left silent, the attachment would appear to
    // work and then vanish on send.
    installIpc({ refuse: true });
    const wrapper = mountComposer();
    await settle();

    wrapper.find('textarea').element.dispatchEvent(new ClipboardEvent('paste', {
      clipboardData: transferWith(pngFile('huge.png')),
      bubbles: true,
      cancelable: true,
    }));
    await settle();

    expect(wrapper.text()).toContain('could not be attached');
    // And nothing is shown as attached, because nothing is.
    expect(wrapper.findAll('[aria-label^="Remove"]')).toHaveLength(0);

    wrapper.unmount();
  });

  it('sends the attachment with the prompt, then forgets it', async () => {
    installIpc();
    const wrapper = mountComposer();
    await settle();

    const textarea = wrapper.find('textarea');
    textarea.element.dispatchEvent(new ClipboardEvent('paste', {
      clipboardData: transferWith(pngFile()),
      bubbles: true,
      cancelable: true,
    }));
    await settle();

    await textarea.setValue('what is this?');
    await textarea.trigger('keydown', { key: 'Enter' });
    await settle();

    const sends = wrapper.emitted('send');
    expect(sends).toHaveLength(1);
    expect(sends![0][0]).toBe('what is this?');
    expect((sends![0][1] as MessageImage[])[0].id).toBe('img_1');

    // The next prompt starts clean — an attachment sent twice would be two
    // copies of the same picture in the conversation.
    expect(wrapper.text()).not.toContain('shot.png');
    await textarea.setValue('and now?');
    await textarea.trigger('keydown', { key: 'Enter' });
    await settle();
    expect(wrapper.emitted('send')![1][1]).toBeUndefined();

    wrapper.unmount();
  });

  it('sends a picture with no question at all', async () => {
    // Empty text is normally refused. A screenshot on its own is a real
    // thing to send, and refusing it makes the attachment useless alone.
    installIpc();
    const wrapper = mountComposer();
    await settle();

    const textarea = wrapper.find('textarea');
    textarea.element.dispatchEvent(new ClipboardEvent('paste', {
      clipboardData: transferWith(pngFile()),
      bubbles: true,
      cancelable: true,
    }));
    await settle();
    await textarea.trigger('keydown', { key: 'Enter' });
    await settle();

    const sends = wrapper.emitted('send');
    expect(sends).toHaveLength(1);
    expect(sends![0][0]).toBe('');
    expect((sends![0][1] as MessageImage[])).toHaveLength(1);

    wrapper.unmount();
  });

  it('still refuses an empty prompt with nothing attached', async () => {
    installIpc();
    const wrapper = mountComposer();
    await settle();

    await wrapper.find('textarea').trigger('keydown', { key: 'Enter' });
    await settle();

    expect(wrapper.emitted('send')).toBeUndefined();

    wrapper.unmount();
  });

  it('lets an attachment be taken off again', async () => {
    installIpc();
    const wrapper = mountComposer();
    await settle();

    wrapper.find('textarea').element.dispatchEvent(new ClipboardEvent('paste', {
      clipboardData: transferWith(pngFile()),
      bubbles: true,
      cancelable: true,
    }));
    await settle();
    expect(wrapper.text()).toContain('shot.png');

    await wrapper.find('[aria-label^="Remove"]').trigger('click');
    await settle();

    expect(wrapper.text()).not.toContain('shot.png');
    // And with nothing attached and nothing typed, there is nothing to send.
    await wrapper.find('textarea').trigger('keydown', { key: 'Enter' });
    expect(wrapper.emitted('send')).toBeUndefined();

    wrapper.unmount();
  });

  it('attaches several images at once', async () => {
    const { saved } = installIpc();
    const wrapper = mountComposer();
    await settle();

    wrapper.find('textarea').element.dispatchEvent(new ClipboardEvent('paste', {
      clipboardData: transferWith(pngFile('one.png'), pngFile('two.png')),
      bubbles: true,
      cancelable: true,
    }));
    await settle();

    expect(saved.map((s) => s.label)).toEqual(['one.png', 'two.png']);
    expect(wrapper.findAll('[aria-label^="Remove"]')).toHaveLength(2);

    wrapper.unmount();
  });
});
