import { describe, it, expect } from 'vitest';

import { sendMessageAddress } from '../send-message';

describe('sendMessageAddress', () => {
  it('reads the agent addressed, and every field the CLI holds it in', () => {
    // The input as CLI 2.1.280 gives it, `to` repeated in `recipient`.
    expect(sendMessageAddress('SendMessage', {
      to: 'aa77f322dcb11a581', message: 'ping', type: 'message', recipient: 'aa77f322dcb11a581', content: 'ping',
    })).toEqual({ address: 'aa77f322dcb11a581', fields: ['to', 'recipient'] });
    expect(sendMessageAddress('SendMessage', { to: 'researcher', message: 'ping' }))
      .toEqual({ address: 'researcher', fields: ['to'] });
  });

  it('has no address for another tool, or a call without one', () => {
    expect(sendMessageAddress('Agent', { to: 'aa77f322dcb11a581' })).toBeNull();
    expect(sendMessageAddress('SendMessage', { message: 'ping' })).toBeNull();
    expect(sendMessageAddress('SendMessage', { to: '' })).toBeNull();
    expect(sendMessageAddress('SendMessage', undefined)).toBeNull();
  });
});
