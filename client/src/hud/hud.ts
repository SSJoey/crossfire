import { HEROES } from '@crossfire/shared/heroes';
import { TUNING } from '@crossfire/shared/tuning';
import type { HeroStatus } from '@crossfire/shared/types';
import { el, setText, show } from '../dom';

export interface HudView {
  wave: number;
  waveBreak: boolean;
  horde: number;
  hp: number;
  maxHp: number;
  status: HeroStatus;
  bleedOut: number;
  /** 0..1 progress of a revive on me. */
  revivedFrac: number;
  outsideRing: boolean;
  /** Name of the body I can revive (standing, within reach), or ''. */
  canRevive: string;
  /** 0..1 progress of the revive I am doing. */
  revivingFrac: number;
  /** Number of standing players (for the full-death revive hint). */
  standing: number;
}

const ember = HEROES.ember;

/** The in-game HUD. All text goes through textContent. */
export class Hud {
  readonly root: HTMLElement;
  private readonly wave = el('span', { id: 'hud-wave', className: 'v', text: '0' });
  private readonly horde = el('span', { id: 'hud-horde', className: 'v', text: '0' });
  private readonly hpFill = el('i');
  private readonly hpText = el('div', { className: 'hptext' });
  private readonly banner = el('div', { id: 'hud-banner', className: 'hud panel banner' });
  private readonly statusTitle = el('div', { className: 't' });
  private readonly statusText = el('div', { className: 's' });
  private readonly statusFill = el('i');
  private readonly statusBar = el('div', { className: 'progress' }, this.statusFill);
  private readonly status = el(
    'div',
    { id: 'hud-status', className: 'hud panel status' },
    this.statusTitle,
    this.statusText,
    this.statusBar,
  );
  private readonly vig = el('div', { id: 'vig' });

  constructor() {
    const help = el(
      'div',
      { className: 'hud panel help' },
      el(
        'div',
        {},
        el('kbd', { text: 'W' }),
        el('kbd', { text: 'A' }),
        el('kbd', { text: 'S' }),
        el('kbd', { text: 'D' }),
        ' move, mouse aims',
      ),
      el('div', {}, el('kbd', { text: 'Click' }), ' attack (hold to repeat)'),
      el('div', {}, el('kbd', { text: 'F' }), ' hold near a fallen teammate to revive'),
      el('div', { text: 'Stay inside the orange ring' }),
    );
    this.root = el(
      'div',
      { className: 'hud-layer' },
      this.vig,
      el(
        'div',
        { className: 'hud panel topbar' },
        el('div', { className: 'stat' }, el('span', { className: 'k', text: 'Wave' }), this.wave),
        el('div', { className: 'stat' }, el('span', { className: 'k', text: 'Horde' }), this.horde),
      ),
      el(
        'div',
        { className: 'hud panel bar' },
        el(
          'div',
          { className: 'heroid' },
          el('div', { className: 'nm' }, ember.name, el('small', { text: 'Fire, ranged' })),
          el('div', { className: 'hp' }, this.hpFill),
          this.hpText,
        ),
        el('div', { className: 'slot' }, el('b', { text: 'Click' }), el('span', { text: ember.basicAttack })),
      ),
      this.banner,
      this.status,
      help,
    );
    this.banner.hidden = true;
    this.status.hidden = true;
  }

  update(v: HudView): void {
    setText(this.wave, String(v.wave));
    setText(this.horde, String(v.horde));
    const frac = v.maxHp > 0 ? Math.max(0, Math.min(1, v.hp / v.maxHp)) : 0;
    this.hpFill.style.transform = `scaleX(${frac})`;
    this.hpFill.classList.toggle('low', frac < 0.3);
    setText(this.hpText, `${Math.ceil(v.hp)} / ${Math.round(v.maxHp)}`);

    // Banner: one line, most urgent first.
    let banner = '';
    let warn = false;
    if (v.status === 'standing') {
      if (v.revivingFrac > 0) banner = `Reviving ${v.canRevive}… keep holding F`;
      else if (v.canRevive) banner = `Hold F to revive ${v.canRevive}`;
      else if (v.outsideRing) {
        banner = 'Outside the ring: you are losing health. Get back in!';
        warn = true;
      } else if (v.waveBreak) banner = `Wave ${v.wave} cleared. Next wave coming…`;
    }
    setText(this.banner, banner);
    this.banner.classList.toggle('warn', warn);
    show(this.banner, banner !== '');

    // Downed or dead panel.
    show(this.status, v.status !== 'standing');
    if (v.status === 'downed') {
      setText(this.statusTitle, "You're down");
      setText(
        this.statusText,
        v.revivedFrac > 0
          ? 'A teammate is reviving you…'
          : `Bleeding out in ${Math.ceil(v.bleedOut)} s. A teammate can hold F next to you.`,
      );
      this.statusFill.style.transform = `scaleX(${v.revivedFrac > 0 ? v.revivedFrac : v.bleedOut / TUNING.revive.bleedOutSec})`;
    } else if (v.status === 'dead') {
      setText(this.statusTitle, 'You died');
      setText(
        this.statusText,
        v.revivedFrac > 0
          ? 'Your team is bringing you back…'
          : `Every standing player (${v.standing}) must gather around you and hold F together for ${TUNING.revive.deadReviveSec} s.`,
      );
      this.statusFill.style.transform = `scaleX(${v.revivedFrac})`;
    }

    const vig =
      v.status === 'standing' && v.outsideRing ? 1 : v.status !== 'standing' ? 0.6 : frac < 0.3 ? 0.5 : 0;
    this.vig.style.opacity = String(vig);
  }
}
