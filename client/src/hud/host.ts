import QRCode from 'qrcode';
import { TUNING } from '@crossfire/shared/tuning';
import { MSG, type Phase } from '@crossfire/shared/types';
import { el, setText } from '../dom';
import { lanAddresses, openAsHost, type GameRoom } from '../net/connection';
import { classifyJoinError } from '../net/joinflow';
import type { RoomState } from '../net/state';

/**
 * The host control page (only works on the host laptop). It is not a player: the host plays
 * from a second tab. Shows the room code, link and QR code, the live player list, and the
 * start, restart, kick and bot controls (all checked again on the server).
 */
export class HostApp {
  private room: GameRoom | null = null;
  private address = '';
  private readonly code = el('div', { id: 'host-code', className: 'big-code', text: '····' });
  private readonly link = el('div', { id: 'host-link', className: 'host-link' });
  private readonly addrSelect = el('select', { id: 'host-addr' });
  private readonly addrLabel = el(
    'label',
    {},
    el('span', { className: 'k', text: 'Network address' }),
    this.addrSelect,
  );
  private readonly qr = el('canvas', { id: 'host-qr', attrs: { width: '200', height: '200' } });
  private readonly count = el('div', {
    id: 'host-count',
    className: 'count',
    text: `0 / ${TUNING.lobby.maxPlayers}`,
  });
  private readonly list = el('ul', { id: 'host-players', className: 'players' });
  private readonly phaseText = el('div', { id: 'host-phase', className: 'muted' });
  private readonly startBtn = el('button', { id: 'host-start', className: 'primary', text: 'Start run' });
  private readonly restartBtn = el('button', { id: 'host-restart', text: 'Back to lobby' });
  /** Pause during a run, Resume while paused (stage 1b.3). */
  private readonly pauseBtn = el('button', { id: 'host-pause', text: 'Pause' });
  private paused = false;
  private readonly addBotBtn = el('button', { id: 'host-add-bot', text: 'Add bot' });
  private readonly removeBotsBtn = el('button', { id: 'host-remove-bots', text: 'Remove bots' });
  private readonly error = el('div', { id: 'host-error', className: 'err', attrs: { role: 'alert' } });

  constructor(root: HTMLElement) {
    this.startBtn.disabled = true;
    this.restartBtn.disabled = true;
    this.pauseBtn.disabled = true;
    this.addBotBtn.disabled = true;
    this.removeBotsBtn.disabled = true;
    this.addrLabel.hidden = true;
    this.addBotBtn.addEventListener('click', () => this.room?.send(MSG.addBot, {}));
    this.removeBotsBtn.addEventListener('click', () => this.room?.send(MSG.removeBots, {}));
    this.startBtn.addEventListener('click', () => this.room?.send(MSG.start, {}));
    this.restartBtn.addEventListener('click', () => this.room?.send(MSG.restart, {}));
    this.pauseBtn.addEventListener('click', () => this.room?.send(this.paused ? MSG.resume : MSG.pause, {}));
    this.addrSelect.addEventListener('change', () => {
      this.address = this.addrSelect.value;
      void this.renderLink();
    });

    root.append(
      el(
        'div',
        { className: 'screen' },
        el(
          'div',
          { className: 'card wide' },
          el('div', { className: 'eyebrow', text: 'Crossfire host' }),
          el(
            'div',
            { className: 'host-grid' },
            el(
              'div',
              { className: 'card' },
              el('div', { className: 'k', text: 'Room code' }),
              this.code,
              el('div', { className: 'k', text: 'Players join at' }),
              this.link,
              this.addrLabel,
              el('div', {
                className: 'muted',
                text: 'Scan the QR code or open the link on a laptop on the same Wi-Fi.',
              }),
            ),
            this.qr,
          ),
          el('div', { className: 'row' }, el('div', { className: 'k', text: 'Players' }), this.count),
          this.list,
          this.phaseText,
          el('div', { className: 'row' }, this.startBtn, this.pauseBtn, this.restartBtn),
          el('div', { className: 'row' }, this.addBotBtn, this.removeBotsBtn),
          el('div', { className: 'muted', text: 'To play yourself, open the link in another tab.' }),
          this.error,
        ),
      ),
    );
    void this.open();
  }

  private async open(): Promise<void> {
    try {
      const [room, addrs] = await Promise.all([openAsHost(), lanAddresses()]);
      this.room = room;
      this.address = addrs[0] ?? location.hostname;
      this.addrSelect.replaceChildren(...addrs.map((a) => el('option', { text: a, attrs: { value: a } })));
      this.addrLabel.hidden = addrs.length < 2;
      setText(this.code, room.roomId);
      await this.renderLink();
      room.onStateChange((s) => this.onState(s));
      room.onLeave(() => setText(this.error, 'Lost the connection to the game server. Reload this page.'));
    } catch (err) {
      setText(this.error, classifyJoinError(err).message);
    }
  }

  private joinUrl(): string {
    const port = location.port ? `:${location.port}` : '';
    return `${location.protocol}//${this.address}${port}/?code=${this.room?.roomId ?? ''}`;
  }

  private async renderLink(): Promise<void> {
    const url = this.joinUrl();
    setText(this.link, url);
    await QRCode.toCanvas(this.qr, url, { width: 200, margin: 1 });
  }

  private onState(s: RoomState): void {
    setText(this.count, `${s.playerCount} / ${TUNING.lobby.maxPlayers}`);
    const rows: string[] = [];
    s.players.forEach((p, id) => rows.push(`${id}|${p.ready ? 1 : 0}|${p.bot ? 1 : 0}|${p.name}`));
    const key = `${s.phase}\n${rows.join('\n')}`;
    if (this.list.dataset.key !== key) {
      this.list.dataset.key = key;
      this.list.replaceChildren();
      s.players.forEach((p, id) => {
        const kick = el('button', { className: 'small', text: 'Kick' });
        kick.addEventListener('click', () => this.room?.send(MSG.kick, { sessionId: id }));
        this.list.append(
          el(
            'li',
            {},
            el('span', { className: 'nm', text: p.name }),
            ...(p.bot ? [el('span', { className: 'bot', text: '(bot)' })] : []),
            el('span', { className: `rd${p.ready ? ' on' : ''}`, text: p.ready ? 'Ready' : 'Not ready' }),
            kick,
          ),
        );
      });
    }
    let allReady = s.players.size > 0;
    let botCount = 0;
    s.players.forEach((p) => {
      if (!p.ready) allReady = false;
      if (p.bot) botCount++;
    });
    const phase: Phase = s.phase;
    this.startBtn.disabled = phase !== 'lobby' || !allReady;
    this.restartBtn.disabled = phase === 'lobby';
    this.paused = phase === 'running' && s.paused;
    this.pauseBtn.disabled = phase !== 'running';
    setText(this.pauseBtn, this.paused ? 'Resume' : 'Pause');
    this.pauseBtn.classList.toggle('primary', this.paused);
    this.addBotBtn.disabled = phase !== 'lobby' || s.players.size >= TUNING.lobby.maxPlayers;
    this.removeBotsBtn.disabled = phase !== 'lobby' || botCount === 0;
    setText(
      this.phaseText,
      phase === 'lobby'
        ? allReady
          ? 'Everyone is ready.'
          : 'Waiting for every player to press ready.'
        : this.paused
          ? `Paused by ${s.pausedBy === '' ? 'the host' : s.pausedBy}. Press "Resume" to play on.`
          : phase === 'running'
            ? `Run in progress: wave ${s.wave}.`
            : `Run over at wave ${s.wave}. Press "Back to lobby" for a new run.`,
    );
  }
}
