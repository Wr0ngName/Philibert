/**
 * Tests for CommandAutocomplete component
 */

import { mount } from '@vue/test-utils';
import { describe, it, expect, vi } from 'vitest';

import type { SlashCommandInfo } from '@shared/types';

import CommandAutocomplete from '../CommandAutocomplete.vue';

const mockCommands: SlashCommandInfo[] = [
  { name: 'help', description: 'Show available commands', argumentHint: '[command]' },
  { name: 'cost', description: 'Show usage costs', argumentHint: '' },
  { name: 'compact', description: 'Compact conversation history', argumentHint: '' },
  { name: 'clear', description: 'Clear conversation', argumentHint: '' },
];

describe('CommandAutocomplete', () => {
  describe('visibility', () => {
    it('should not render when show is false', () => {
      const wrapper = mount(CommandAutocomplete, {
        props: {
          commands: mockCommands,
          inputValue: '/he',
          show: false,
        },
      });

      expect(wrapper.find('[role="listbox"]').exists()).toBe(false);
    });

    it('should render when show is true and has filtered commands', () => {
      const wrapper = mount(CommandAutocomplete, {
        props: {
          commands: mockCommands,
          inputValue: '/he',
          show: true,
        },
      });

      expect(wrapper.find('[role="listbox"]').exists()).toBe(true);
    });

    it('should not render when no commands match filter', () => {
      const wrapper = mount(CommandAutocomplete, {
        props: {
          commands: mockCommands,
          inputValue: '/xyz',
          show: true,
        },
      });

      expect(wrapper.find('[role="listbox"]').exists()).toBe(false);
    });
  });

  describe('filtering', () => {
    it('should show all commands when only / is typed', () => {
      const wrapper = mount(CommandAutocomplete, {
        props: {
          commands: mockCommands,
          inputValue: '/',
          show: true,
        },
      });

      const options = wrapper.findAll('[role="option"]');
      expect(options).toHaveLength(4);
    });

    it('should filter commands by name', () => {
      const wrapper = mount(CommandAutocomplete, {
        props: {
          commands: mockCommands,
          inputValue: '/co',
          show: true,
        },
      });

      // cost and compact match by name. Descriptions are not searched at two
      // characters — "co" is inside "commands" and "conversation" too, so
      // doing it there would widen the list instead of narrowing it.
      const options = wrapper.findAll('[role="option"]');
      expect(options).toHaveLength(2);
    });

    it('should be case insensitive', () => {
      const wrapper = mount(CommandAutocomplete, {
        props: {
          commands: mockCommands,
          inputValue: '/HE',
          show: true,
        },
      });

      const options = wrapper.findAll('[role="option"]');
      expect(options).toHaveLength(1);
      expect(options[0].text()).toContain('/help');
    });

    it('should only match command name part, not arguments', () => {
      const wrapper = mount(CommandAutocomplete, {
        props: {
          commands: mockCommands,
          inputValue: '/help some argument',
          show: true,
        },
      });

      const options = wrapper.findAll('[role="option"]');
      expect(options).toHaveLength(1);
      expect(options[0].text()).toContain('/help');
    });
  });

  describe('display', () => {
    it('should show command name with / prefix', () => {
      const wrapper = mount(CommandAutocomplete, {
        props: {
          commands: mockCommands,
          inputValue: '/help',
          show: true,
        },
      });

      expect(wrapper.text()).toContain('/help');
    });

    it('should show argument hint when available', () => {
      const wrapper = mount(CommandAutocomplete, {
        props: {
          commands: mockCommands,
          inputValue: '/help',
          show: true,
        },
      });

      expect(wrapper.text()).toContain('[command]');
    });

    it('should show description when available', () => {
      const wrapper = mount(CommandAutocomplete, {
        props: {
          commands: mockCommands,
          inputValue: '/help',
          show: true,
        },
      });

      expect(wrapper.text()).toContain('Show available commands');
    });

    it('should show placeholder when no description', () => {
      const commandsWithoutDesc: SlashCommandInfo[] = [
        { name: 'test', description: '', argumentHint: '' },
      ];

      const wrapper = mount(CommandAutocomplete, {
        props: {
          commands: commandsWithoutDesc,
          inputValue: '/test',
          show: true,
        },
      });

      expect(wrapper.text()).toContain('No description available');
    });
  });

  describe('selection', () => {
    it('should highlight first item by default', () => {
      const wrapper = mount(CommandAutocomplete, {
        props: {
          commands: mockCommands,
          inputValue: '/',
          show: true,
        },
      });

      const options = wrapper.findAll('[role="option"]');
      expect(options[0].attributes('aria-selected')).toBe('true');
      expect(options[1].attributes('aria-selected')).toBe('false');
    });

    it('should emit select event on click', async () => {
      const wrapper = mount(CommandAutocomplete, {
        props: {
          commands: mockCommands,
          inputValue: '/',
          show: true,
        },
      });

      await wrapper.findAll('[role="option"]')[1].trigger('click');

      // The list is ordered, not left in the order the SDK happened to send:
      // Claude Code's own commands first, then alphabetically. None of these
      // fixtures is marked builtin, so the order is clear, compact, cost,
      // help — making the second row "compact".
      expect(wrapper.emitted('select')).toBeTruthy();
      expect(wrapper.emitted('select')![0]).toEqual([
        mockCommands.find((c) => c.name === 'compact'),
      ]);
    });

    it('should update selection on mouse enter', async () => {
      const wrapper = mount(CommandAutocomplete, {
        props: {
          commands: mockCommands,
          inputValue: '/',
          show: true,
        },
      });

      await wrapper.findAll('[role="option"]')[2].trigger('mouseenter');

      const options = wrapper.findAll('[role="option"]');
      expect(options[2].attributes('aria-selected')).toBe('true');
    });
  });

  describe('keyboard navigation', () => {
    it('should handle ArrowDown key', () => {
      const wrapper = mount(CommandAutocomplete, {
        props: {
          commands: mockCommands,
          inputValue: '/',
          show: true,
        },
      });

      const event = new KeyboardEvent('keydown', { key: 'ArrowDown' });
      const spy = vi.spyOn(event, 'preventDefault');

      const handled = wrapper.vm.handleKeydown(event);

      expect(handled).toBe(true);
      expect(spy).toHaveBeenCalled();
    });

    it('should handle ArrowUp key', () => {
      const wrapper = mount(CommandAutocomplete, {
        props: {
          commands: mockCommands,
          inputValue: '/',
          show: true,
        },
      });

      // Move down first
      wrapper.vm.handleKeydown(new KeyboardEvent('keydown', { key: 'ArrowDown' }));

      const event = new KeyboardEvent('keydown', { key: 'ArrowUp' });
      const spy = vi.spyOn(event, 'preventDefault');

      const handled = wrapper.vm.handleKeydown(event);

      expect(handled).toBe(true);
      expect(spy).toHaveBeenCalled();
    });

    it('should handle Tab key for selection', () => {
      const wrapper = mount(CommandAutocomplete, {
        props: {
          commands: mockCommands,
          inputValue: '/',
          show: true,
        },
      });

      const event = new KeyboardEvent('keydown', { key: 'Tab' });
      const spy = vi.spyOn(event, 'preventDefault');

      const handled = wrapper.vm.handleKeydown(event);

      expect(handled).toBe(true);
      expect(spy).toHaveBeenCalled();
      expect(wrapper.emitted('select')).toBeTruthy();
    });

    it('should NOT handle Enter key (allows form submission)', () => {
      const wrapper = mount(CommandAutocomplete, {
        props: {
          commands: mockCommands,
          inputValue: '/',
          show: true,
        },
      });

      const event = new KeyboardEvent('keydown', { key: 'Enter' });
      const handled = wrapper.vm.handleKeydown(event);

      // Enter should not be handled - let it bubble up for form submission
      expect(handled).toBe(false);
      expect(wrapper.emitted('select')).toBeFalsy();
    });

    it('should not handle keys when hidden', () => {
      const wrapper = mount(CommandAutocomplete, {
        props: {
          commands: mockCommands,
          inputValue: '/',
          show: false,
        },
      });

      const event = new KeyboardEvent('keydown', { key: 'ArrowDown' });
      const handled = wrapper.vm.handleKeydown(event);

      expect(handled).toBe(false);
    });

    it('should not navigate past first item', () => {
      const wrapper = mount(CommandAutocomplete, {
        props: {
          commands: mockCommands,
          inputValue: '/',
          show: true,
        },
      });

      // Try to go up when at first item
      wrapper.vm.handleKeydown(new KeyboardEvent('keydown', { key: 'ArrowUp' }));

      const options = wrapper.findAll('[role="option"]');
      expect(options[0].attributes('aria-selected')).toBe('true');
    });

    it('should not navigate past last item', async () => {
      const wrapper = mount(CommandAutocomplete, {
        props: {
          commands: mockCommands,
          inputValue: '/',
          show: true,
        },
      });

      // Navigate to end and try to go further
      for (let i = 0; i < 10; i++) {
        wrapper.vm.handleKeydown(new KeyboardEvent('keydown', { key: 'ArrowDown' }));
      }

      // Wait for Vue reactivity to update
      await wrapper.vm.$nextTick();

      const options = wrapper.findAll('[role="option"]');
      expect(options[options.length - 1].attributes('aria-selected')).toBe('true');
    });
  });

  describe('input change reset', () => {
    it('should reset selection when input changes', async () => {
      const wrapper = mount(CommandAutocomplete, {
        props: {
          commands: mockCommands,
          inputValue: '/',
          show: true,
        },
      });

      // Navigate down
      wrapper.vm.handleKeydown(new KeyboardEvent('keydown', { key: 'ArrowDown' }));
      wrapper.vm.handleKeydown(new KeyboardEvent('keydown', { key: 'ArrowDown' }));

      // Change input
      await wrapper.setProps({ inputValue: '/c' });

      const options = wrapper.findAll('[role="option"]');
      expect(options[0].attributes('aria-selected')).toBe('true');
    });
  });
});
