/** Messages between a room (parent) and its bot process (child). Only the server writes these. */
export type ToBotProcess =
  { type: 'add'; url: string; code: string; name: string; seed: number; ticket: string } | { type: 'stop' };

export type FromBotProcess = { type: 'failed'; name: string; error: string };
