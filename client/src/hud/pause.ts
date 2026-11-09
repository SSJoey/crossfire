/** Pause banner texts (stage 1b.3). Plain strings: the HUD sets them with textContent. */

/** `pausedBy` is a player's name, or '' when the host page paused. */
export function pauseText(pausedBy: string, myName: string): string {
  const who = pausedBy === '' ? 'the host' : pausedBy === myName ? 'you' : pausedBy;
  return `Paused by ${who}. Waiting for the host to resume.`;
}

/** Shown when Esc is pressed during the player's own pause cooldown. */
export function pauseHint(secondsLeft: number): string {
  return `Pause available in ${secondsLeft} s`;
}
