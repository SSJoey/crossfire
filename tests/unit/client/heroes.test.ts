import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import {
  ELEMENT_COLOR,
  elementAt,
  elementIndex,
  ELEMENT_IDS,
  HEROES,
  HERO_IDS,
} from '@crossfire/shared/heroes';
import { assistRange } from '@crossfire/shared/rules/abilities';
import { TUNING } from '@crossfire/shared/tuning';
import { ENEMY_FX } from '@crossfire/shared/types';
import { cdFrac, heroText } from '../../../client/src/hud/abilities';
import { HERO_ANIM, HERO_CLIPS, MODEL_FILES } from '../../../client/src/render/clips';
import { statusGlow, zoneOpacity } from '../../../client/src/render/fx';
import { applyTint } from '../../../client/src/render/tint';

describe('HUD ability slots (1b.2)', () => {
  it('cdFrac is the share of the cooldown left, always within 0..1', () => {
    expect(cdFrac(0, 5)).toBe(0);
    expect(cdFrac(2.5, 5)).toBeCloseTo(0.5, 9);
    expect(cdFrac(5, 5)).toBe(1);
    expect(cdFrac(9, 5)).toBe(1);
    expect(cdFrac(-1, 5)).toBe(0);
    expect(cdFrac(1, 0)).toBe(0);
    expect(cdFrac(Number.NaN, 5)).toBe(0);
  });

  it('slot labels come from the hero definition', () => {
    expect(heroText('ember')).toEqual({
      name: 'Ember',
      sub: 'Fire, ranged',
      basic: 'Fire bolt',
      q: 'Fire zone',
      e: 'Flame step',
      passive: 'Kindle',
    });
    expect(heroText('bastion').sub).toBe('Earth, melee');
    expect(heroText('tide').sub).toBe('Water, ranged');
    expect(heroText('gale').sub).toBe('Air, melee');
    for (const id of HERO_IDS) {
      const t = heroText(id);
      const d = HEROES[id];
      expect([t.name, t.basic, t.q, t.e, t.passive], id).toEqual([
        d.name,
        d.basicAttack,
        d.zone,
        d.utility,
        d.passive,
      ]);
    }
  });
});

describe('hero art (1b.2)', () => {
  it('every hero has a model file and clips that the pipeline keeps', () => {
    for (const id of HERO_IDS) {
      expect(MODEL_FILES.heroes[id], id).toBe(`${HEROES[id].model}.glb`);
      for (const clip of Object.values(HERO_ANIM[id])) {
        if (clip) expect(HERO_CLIPS, `${id} ${clip}`).toContain(clip);
      }
    }
  });

  it('the clips fit each weapon (NOTES.md 2026-11-09, 1b.2 answer 2)', () => {
    expect(HERO_ANIM.ember).toEqual({ attack: 'Spellcast_Shoot', q: 'Spellcast_Raise', e: null });
    expect(HERO_ANIM.tide).toEqual({ attack: '1H_Ranged_Shoot', q: 'Spellcast_Raise', e: 'Spellcast_Raise' });
    expect(HERO_ANIM.bastion).toEqual({
      attack: '1H_Melee_Attack_Chop',
      q: '1H_Melee_Attack_Chop',
      e: 'Block',
    });
    expect(HERO_ANIM.gale).toEqual({
      attack: 'Dualwield_Melee_Attack_Chop',
      q: '1H_Melee_Attack_Chop',
      e: 'Dodge_Forward',
    });
  });

  it("Tide's tint multiplies every mesh material colour by 0xa9c6ff", () => {
    const root = new THREE.Group();
    const a = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial({ color: 0xffffff }));
    const b = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial({ color: 0x808080 }));
    root.add(a);
    a.add(b);
    applyTint(root, 0xa9c6ff);
    const tint = new THREE.Color(0xa9c6ff);
    expect((a.material as THREE.MeshStandardMaterial).color.equals(tint)).toBe(true);
    const want = new THREE.Color(0x808080).multiply(tint);
    expect((b.material as THREE.MeshStandardMaterial).color.equals(want)).toBe(true);
  });

  it('a material shared by several meshes is tinted once', () => {
    const root = new THREE.Group();
    const mat = new THREE.MeshStandardMaterial({ color: 0xffffff });
    root.add(new THREE.Mesh(new THREE.BoxGeometry(), mat), new THREE.Mesh(new THREE.BoxGeometry(), mat));
    applyTint(root, 0xa9c6ff);
    expect(mat.color.equals(new THREE.Color(0xa9c6ff))).toBe(true);
  });

  it('elements round-trip through the synced byte; colours are the look-test ones', () => {
    for (const el of ELEMENT_IDS) expect(elementAt(elementIndex(el))).toBe(el);
    expect(elementAt(99)).toBe('fire');
    expect(ELEMENT_COLOR).toEqual({ fire: 0xff6a2b, earth: 0xc9934a, water: 0x3fa7ff, air: 0xbdf5ff });
  });
});

describe('effects (1b.2)', () => {
  const D = TUNING.zones.durationSec;

  it('a zone fades in, holds, then fades out, always within 0..1', () => {
    expect(zoneOpacity(D, D)).toBe(0);
    expect(zoneOpacity(D - 1, D)).toBe(1);
    expect(zoneOpacity(0, D)).toBe(0);
    for (let r = -1; r <= D + 1; r += 0.05) {
      const o = zoneOpacity(r, D);
      expect(o).toBeGreaterThanOrEqual(0);
      expect(o).toBeLessThanOrEqual(1);
    }
    expect(zoneOpacity(0.1, D)).toBeLessThan(zoneOpacity(1, D));
  });

  it('an enemy status glow shows the most important effect: stunned, then burning, then slowed', () => {
    expect(statusGlow(0)).toBeNull();
    expect(statusGlow(ENEMY_FX.slowed)).toBe(0x3fa7ff);
    expect(statusGlow(ENEMY_FX.burning | ENEMY_FX.slowed)).toBe(0xff6a2b);
    expect(statusGlow(ENEMY_FX.stunned | ENEMY_FX.burning)).toBe(0xffe14a);
  });
});

describe('aim-assist range per hero (shared with the server)', () => {
  it('ranged heroes use bolt range; melee heroes reach + assistExtra', () => {
    const H = TUNING.heroes;
    expect(assistRange('ember')).toBe(H.ember.bolt.range);
    expect(assistRange('tide')).toBe(H.tide.bolt.range);
    expect(assistRange('bastion')).toBeCloseTo(H.bastion.melee.reach + TUNING.melee.assistExtra, 9);
    expect(assistRange('gale')).toBeCloseTo(H.gale.melee.reach + TUNING.melee.assistExtra, 9);
  });
});
