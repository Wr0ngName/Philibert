/**
 * Tests for the model mismatch banner.
 *
 * The explanation lives here rather than inside the model picker: the picker is
 * a narrow dropdown of one-line rows and a full sentence does not fit it.
 */

import { mount, flushPromises } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import type { ModelInfo } from '@shared/types';

import { useChatStore } from '../../../stores/chat';
import { useSettingsStore } from '../../../stores/settings';
import ModelMismatchBanner from '../ModelMismatchBanner.vue';

const CONV = 'conv-1';

function setupElectron(models: ModelInfo[]) {
  (globalThis as unknown as { window: Record<string, unknown> }).window.electron = {
    claude: {
      onModelsChanged: () => () => {},
      getModels: vi.fn().mockResolvedValue(models),
    },
  } as never;
}

/**
 * The main-loop model now lives in the chat store, registered once in
 * useClaudeChat, rather than each component opening its own IPC listener.
 */
function setActiveModel(model: string) {
  const chat = useChatStore();
  chat.currentConversationId = CONV;
  chat.setActiveModel(CONV, model);
}

async function mountWith(selected: string, running: string, models: ModelInfo[] = []) {
  setupElectron(models);
  const settings = useSettingsStore();
  settings.config.selectedModel = selected;

  setActiveModel(running);
  const wrapper = mount(ModelMismatchBanner, {
    global: { stubs: { Icon: true } },
  });
  await flushPromises();
  return wrapper;
}

describe('ModelMismatchBanner', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('shows nothing when the running model matches the selection', async () => {
    const wrapper = await mountWith('claude-opus-4-8', 'claude-opus-4-8');
    expect(wrapper.text()).toBe('');
  });

  it('shows nothing when no model is pinned', async () => {
    const wrapper = await mountWith('', 'claude-fable-5');
    expect(wrapper.text()).toBe('');
  });

  it('announces a genuine substitution', async () => {
    const wrapper = await mountWith('claude-opus-4-8', 'claude-fable-5');
    expect(wrapper.text()).toContain('Running');
    expect(wrapper.text()).toContain('Fable 5');
    expect(wrapper.text()).toContain('Opus 4.8');
  });

  // A context-window variant is the same underlying model.
  it('does not fire for a [1m] context variant of the same model', async () => {
    const wrapper = await mountWith('claude-opus-5', 'claude-opus-5[1m]');
    expect(wrapper.text()).toBe('');
  });

  // The SDK returns family aliases whose resolvedModel names the concrete ID.
  it('does not fire when an alias resolves to the running model', async () => {
    const wrapper = await mountWith('opus[1m]', 'claude-opus-5[1m]', [
      { value: 'opus[1m]', resolvedModel: 'claude-opus-5[1m]', displayName: 'Opus (1M context)' },
    ]);
    expect(wrapper.text()).toBe('');
  });

  it('can be dismissed', async () => {
    const wrapper = await mountWith('claude-opus-4-8', 'claude-fable-5');
    expect(wrapper.text()).toContain('Running');

    await wrapper.findAll('button').at(-1)!.trigger('click');
    expect(wrapper.text()).toBe('');
  });

  it('re-announces when the model changes again after a dismissal', async () => {
    const wrapper = await mountWith('claude-opus-4-8', 'claude-fable-5');
    await wrapper.findAll('button').at(-1)!.trigger('click');
    expect(wrapper.text()).toBe('');

    // A different substitution is new information, not the one just dismissed.
    setActiveModel('claude-sonnet-5');
    await flushPromises();
    expect(wrapper.text()).toContain('Sonnet 5');
  });
});
