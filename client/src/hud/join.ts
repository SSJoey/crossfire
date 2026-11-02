import { TUNING } from '@crossfire/shared/tuning';
import { MSG, SERVER_MSG, type RunEndedMessage } from '@crossfire/shared/types';
import { debugView } from '../debug';
import { el, formatTime, setText, show } from '../dom';
import { Game } from '../game';
import { joinAsPlayer, type GameRoom } from '../net/connection';
import { classifyJoinError, closeMessage, normaliseRoomCode, parseRoomCode } from '../net/joinflow';
import type { RoomState } from '../net/state';
import { loadModels, type Models } from '../render/assets';
import { isTier, resolveTier, saveTier, TIERS, type Store, type Tier } from '../render/tiers';

function storage(): Store | undefined {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

const NAME_KEY = 'crossfire.name';

/**
 * The player's page: join form → lobby → game → end screen → lobby again.
 * Late joiners and an unreachable host retry every few seconds on their own.
 */
export class JoinApp {
  private readonly app: HTMLElement;
  private tier: Tier;
  private models: Promise<Models> | null = null;
  private room: GameRoom | null = null;
  private game: Game | null = null;
  private retryTimer = 0;
  private countdownTimer = 0;
  private phase = '';

  // Join form
  private readonly codeInput = el('input', {
    id: 'join-code',
    attrs: {
      type: 'text',
      maxlength: '4',
      autocomplete: 'off',
      autocapitalize: 'characters',
      placeholder: 'ABCD',
    },
  });
  private readonly codeLabel = el(
    'label',
    {},
    el('span', { className: 'k', text: 'Room code' }),
    this.codeInput,
  );
  private readonly nameInput = el('input', {
    id: 'join-name',
    attrs: { type: 'text', maxlength: '64', autocomplete: 'nickname', placeholder: 'Your name' },
  });
  private readonly tierSelect = el('select', { id: 'join-tier' });
  private readonly joinBtn = el('button', {
    id: 'join-btn',
    className: 'primary',
    text: 'Join',
    attrs: { type: 'submit' },
  });
  private readonly joinError = el('div', { id: 'join-error', className: 'err', attrs: { role: 'alert' } });
  private readonly joinStatus = el('div', { className: 'muted', attrs: { 'aria-live': 'polite' } });
  private readonly joinScreen: HTMLElement;

  // Lobby
  private readonly lobbyList = el('ul', { id: 'lobby-players', className: 'players' });
  private readonly lobbyCount = el('div', { className: 'muted' });
  private readonly readyBtn = el('button', { id: 'lobby-ready', className: 'primary', text: "I'm ready" });
  private readonly lobbyLoad = el('div', { className: 'muted' });
  private readonly lobbyScreen: HTMLElement;

  // End screen
  private readonly endWave = el('div', { id: 'end-wave', className: 'v', text: '0' });
  private readonly endTime = el('div', { id: 'end-time', className: 'v', text: '0:00' });
  private readonly endScreen: HTMLElement;

  constructor(root: HTMLElement) {
    this.app = root;
    const store = storage();
    this.tier = resolveTier(location.search, store);
    for (const [k, t] of Object.entries(TIERS)) {
      const o = el('option', { text: t.label, attrs: { value: k } });
      this.tierSelect.append(o);
    }
    this.tierSelect.value = this.tier;
    this.tierSelect.addEventListener('change', () => {
      const v = this.tierSelect.value;
      if (isTier(v)) {
        this.tier = v;
        saveTier(store, v);
        this.game?.setTier(v);
      }
    });
    try {
      this.nameInput.value = store?.getItem(NAME_KEY) ?? '';
    } catch {
      // ignore
    }

    const code = parseRoomCode(location.search);
    if (code) {
      this.codeInput.value = code;
      this.codeLabel.hidden = true;
    }

    const form = el(
      'form',
      { className: 'card' },
      el('div', { className: 'eyebrow', text: 'Crossfire' }),
      el('h1', { text: 'Hold the point' }),
      el('p', { text: 'Defend the hold point with your friends. Stay inside the orange ring.' }),
      this.codeLabel,
      el('label', {}, el('span', { className: 'k', text: 'Name' }), this.nameInput),
      el('label', {}, el('span', { className: 'k', text: 'Graphics' }), this.tierSelect),
      el('div', { className: 'row' }, this.joinBtn),
      this.joinError,
      this.joinStatus,
    );
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      void this.join();
    });
    this.joinScreen = el('div', { className: 'screen' }, form);

    this.readyBtn.addEventListener('click', () => {
      const p = this.room?.state.players.get(this.room.sessionId);
      this.room?.send(MSG.ready, { ready: !p?.ready });
    });
    this.lobbyScreen = el(
      'div',
      { className: 'screen' },
      el(
        'div',
        { className: 'card' },
        el('div', { className: 'eyebrow', text: 'Lobby' }),
        el('h1', { text: 'Get ready' }),
        this.lobbyCount,
        this.lobbyList,
        el('div', { className: 'row' }, this.readyBtn),
        el('div', { className: 'muted', text: 'The host starts the run when everyone is ready.' }),
        this.lobbyLoad,
      ),
    );

    this.endScreen = el(
      'div',
      { id: 'end-screen', className: 'screen' },
      el(
        'div',
        { className: 'card' },
        el('div', { className: 'eyebrow', text: 'Run over' }),
        el('h1', { text: 'The hold has fallen' }),
        el(
          'div',
          { className: 'end-stats' },
          el('div', {}, el('div', { className: 'k', text: 'Wave reached' }), this.endWave),
          el('div', {}, el('div', { className: 'k', text: 'Time held' }), this.endTime),
        ),
        el('div', { className: 'muted', text: 'Waiting for the host to start a new run.' }),
      ),
    );

    this.lobbyScreen.hidden = true;
    this.endScreen.hidden = true;
    this.app.append(this.joinScreen, this.lobbyScreen, this.endScreen);
    (code ? this.nameInput : this.codeInput).focus();
  }

  private clearTimers(): void {
    clearTimeout(this.retryTimer);
    clearInterval(this.countdownTimer);
  }

  private async join(): Promise<void> {
    this.clearTimers();
    const code = normaliseRoomCode(this.codeInput.value);
    if (!code) {
      setText(this.joinError, 'Enter the 4-letter room code from the host screen.');
      return;
    }
    const name = this.nameInput.value;
    try {
      storage()?.setItem(NAME_KEY, name);
    } catch {
      // ignore
    }
    setText(this.joinError, '');
    setText(this.joinStatus, 'Joining…');
    this.joinBtn.disabled = true;
    try {
      const room = await joinAsPlayer(code, name);
      this.onJoined(room);
    } catch (err) {
      const f = classifyJoinError(err);
      setText(this.joinError, f.message);
      setText(this.joinStatus, '');
      if (f.retryMs !== null) this.scheduleRetry(f.retryMs);
    } finally {
      this.joinBtn.disabled = false;
    }
  }

  private scheduleRetry(ms: number): void {
    let left = Math.round(ms / 1000);
    setText(this.joinStatus, `Trying again in ${left} s…`);
    this.countdownTimer = window.setInterval(() => {
      left = Math.max(0, left - 1);
      setText(this.joinStatus, `Trying again in ${left} s…`);
    }, 1000);
    this.retryTimer = window.setTimeout(() => void this.join(), ms);
  }

  private onJoined(room: GameRoom): void {
    this.room = room;
    this.joinScreen.hidden = true;
    // Start loading models while in the lobby.
    this.models ??= loadModels((f) =>
      setText(this.lobbyLoad, f < 1 ? `Loading characters… ${Math.round(f * 100)}%` : ''),
    );
    this.models.catch(() =>
      setText(this.lobbyLoad, 'The character models did not load. Reload the page to try again.'),
    );

    room.onStateChange((s) => this.onState(s));
    room.onMessage(SERVER_MSG.ended, (m: RunEndedMessage) => {
      setText(this.endWave, String(m.wave));
      setText(this.endTime, formatTime(m.durationSec));
    });
    room.onLeave((code) => this.onLeft(code));
  }

  private onState(s: RoomState): void {
    // Lobby list: rebuilt only when it changes (names as text only).
    const names: string[] = [];
    s.players.forEach((p, id) =>
      names.push(`${id === this.room?.sessionId ? '1' : '0'}${p.ready ? '1' : '0'}${p.name}`),
    );
    const key = names.join('\n');
    if (this.lobbyList.dataset.key !== key) {
      this.lobbyList.dataset.key = key;
      this.lobbyList.replaceChildren();
      s.players.forEach((p, id) => {
        this.lobbyList.append(
          el(
            'li',
            {},
            el('span', { className: 'nm', text: p.name }),
            id === this.room?.sessionId ? el('span', { className: 'k', text: 'you' }) : null,
            el('span', { className: `rd${p.ready ? ' on' : ''}`, text: p.ready ? 'Ready' : 'Not ready' }),
          ),
        );
      });
      setText(this.lobbyCount, `${s.players.size} of ${TUNING.lobby.maxPlayers} players`);
      const me = this.room ? s.players.get(this.room.sessionId) : undefined;
      setText(this.readyBtn, me?.ready ? 'Not ready' : "I'm ready");
      this.readyBtn.classList.toggle('primary', !me?.ready);
    }

    if (s.phase === this.phase) return;
    const prev = this.phase;
    this.phase = s.phase;
    debugView().phase = s.phase;
    if (s.phase === 'lobby') {
      show(this.lobbyScreen, true);
      show(this.endScreen, false);
      if (this.game) {
        this.game.stop();
        this.game.resetRun();
        this.game.root.hidden = true;
      }
    } else if (s.phase === 'running') {
      show(this.lobbyScreen, false);
      show(this.endScreen, false);
      void this.startGame();
    } else if (s.phase === 'ended') {
      show(this.endScreen, true);
      if (prev === '') setText(this.endWave, String(s.wave));
    }
  }

  private async startGame(): Promise<void> {
    if (!this.room || !this.models) return;
    const models = await this.models;
    if (!this.game) {
      this.game = new Game(models, this.room, this.tier);
      this.app.prepend(this.game.root);
    }
    this.game.root.hidden = false;
    this.game.start();
  }

  private onLeft(code: number): void {
    this.game?.dispose();
    this.game = null;
    this.room = null;
    this.phase = '';
    debugView().phase = 'none';
    debugView().me = null;
    show(this.lobbyScreen, false);
    show(this.endScreen, false);
    show(this.joinScreen, true);
    setText(this.joinError, closeMessage(code) ?? '');
    setText(this.joinStatus, '');
  }
}
