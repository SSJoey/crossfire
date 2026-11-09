import { describe, expect, it } from 'vitest';
import { pauseHint, pauseText } from '../../../client/src/hud/pause';
import { isGameKey, isPauseKey } from '../../../client/src/input/keys';

describe('pause key (1b.3)', () => {
  it('Esc pauses once per press; a held repeat does not', () => {
    expect(isPauseKey('Escape', false)).toBe(true);
    expect(isPauseKey('Escape', true)).toBe(false);
    expect(isPauseKey('KeyP', false)).toBe(false);
    expect(isPauseKey('KeyQ', false)).toBe(false);
  });

  it('Esc is a game key (browser default prevented)', () => {
    expect(isGameKey('Escape')).toBe(true);
  });
});

describe('pause banner text (1b.3)', () => {
  it('names who paused', () => {
    expect(pauseText('Ann', 'Bo')).toBe('Paused by Ann. Waiting for the host to resume.');
  });

  it('says "you" for my own pause', () => {
    expect(pauseText('Ann', 'Ann')).toBe('Paused by you. Waiting for the host to resume.');
  });

  it('an empty pauser is the host page', () => {
    expect(pauseText('', 'Ann')).toBe('Paused by the host. Waiting for the host to resume.');
  });

  it('cooldown hint', () => {
    expect(pauseHint(7)).toBe('Pause available in 7 s');
  });
});
