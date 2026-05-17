import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PluginFrontendRegistry } from '../index';

// ─── Basic round-trips ───────────────────────────────────────────────────────
describe('PluginFrontendRegistry — basic round-trips', () => {
  it('registers and retrieves nav items', () => {
    const registry = new PluginFrontendRegistry();
    registry.registerNav('test', [
      { group: 'Tools', label: 'Test', path: '/test', icon: 'box' },
    ]);
    const items = registry.getNavItems();
    expect(items).toHaveLength(1);
    expect(items[0].label).toBe('Test');
  });

  it('merges nav items from multiple plugins', () => {
    const registry = new PluginFrontendRegistry();
    registry.registerNav('a', [{ group: 'Tools', label: 'A', path: '/a', icon: 'box' }]);
    registry.registerNav('b', [{ group: 'Tools', label: 'B', path: '/b', icon: 'box' }]);
    expect(registry.getNavItems()).toHaveLength(2);
  });

  it('registers and retrieves page routes', () => {
    const registry = new PluginFrontendRegistry();
    const FakePage = () => null;
    registry.registerPages('test', [
      { path: '/test', component: FakePage as any },
    ]);
    const pages = registry.getPages();
    expect(pages).toHaveLength(1);
    expect(pages[0].path).toBe('/test');
    expect(pages[0].component).toBe(FakePage);
  });

  it('registers and retrieves commands', () => {
    const registry = new PluginFrontendRegistry();
    registry.registerCommands('test', [
      { id: 'test:hello', label: 'Say Hello', action: () => {} },
    ]);
    const cmds = registry.getCommands();
    expect(cmds).toHaveLength(1);
    expect(cmds[0].id).toBe('test:hello');
  });

  it('registers and retrieves protocol decoders', () => {
    const registry = new PluginFrontendRegistry();
    const decoder = { id: 'test', name: 'Test', detect: () => false, decodeFrames: () => [] };
    registry.registerDecoders('test', [decoder]);
    expect(registry.getDecoders()).toHaveLength(1);
  });

  it('re-enables plugins when setDisabledPlugins is updated', () => {
    const registry = new PluginFrontendRegistry();
    registry.registerNav('plugin-a', [{ group: 'test', label: 'A', path: '/a', icon: 'box' }]);
    registry.registerNav('plugin-b', [{ group: 'test', label: 'B', path: '/b', icon: 'box' }]);

    registry.setDisabledPlugins(['plugin-a']);
    expect(registry.getNavItems()).toHaveLength(1);
    expect(registry.getNavItems()[0].label).toBe('B');

    registry.setDisabledPlugins([]);
    expect(registry.getNavItems()).toHaveLength(2);
  });
});

// ─── Reactivity guards: regressions to prevent ──────────────────────────────
// These tests exist to guard against two bugs that caused user-visible
// flashing on the Documents page (constant flicker) and Kitchen Sink nav
// (one-time flash on initial load).
describe('setDisabledPlugins — reactivity correctness', () => {
  let reg: PluginFrontendRegistry;
  beforeEach(() => { reg = new PluginFrontendRegistry(); });

  // Bug A: AuthenticatedApp re-rendered → wsManager re-created → useEffect
  // re-fired → fetched plugin list → setDisabledPlugins called with same
  // names → notified subscribers → AuthenticatedApp re-rendered again →
  // infinite loop. Equality short-circuit breaks the loop.
  it('does not notify subscribers when called with the same names twice', () => {
    reg.setDisabledPlugins(['plugin-a']); // first call — notifies (and marks loaded)
    let count = 0;
    reg.subscribe(() => { count++; });
    reg.setDisabledPlugins(['plugin-a']); // same names — must NOT notify
    expect(count).toBe(0);
  });

  it('treats name order as irrelevant for equality', () => {
    reg.setDisabledPlugins(['a', 'b']);
    let count = 0;
    reg.subscribe(() => { count++; });
    reg.setDisabledPlugins(['b', 'a']); // same set, different order — must NOT notify
    expect(count).toBe(0);
  });

  it('notifies when names actually change', () => {
    reg.setDisabledPlugins(['plugin-a']);
    let count = 0;
    reg.subscribe(() => { count++; });
    reg.setDisabledPlugins(['plugin-b']); // different — must notify
    expect(count).toBe(1);
  });
});

describe('isDisabledLoaded — initial-load gate', () => {
  // Bug B: plugin nav items rendered before the disabled-plugin fetch
  // resolved, so the Kitchen Sink nav item flashed briefly. Components can
  // gate plugin contributions on isDisabledLoaded() to wait for the first
  // server response.
  it('returns false before any setDisabledPlugins call', () => {
    const reg = new PluginFrontendRegistry();
    expect(reg.isDisabledLoaded()).toBe(false);
  });

  it('flips to true after first setDisabledPlugins call (even with empty list)', () => {
    const reg = new PluginFrontendRegistry();
    reg.setDisabledPlugins([]);
    expect(reg.isDisabledLoaded()).toBe(true);
  });

  it('notifies subscribers on the first call (loaded transition) regardless of names', () => {
    const reg = new PluginFrontendRegistry();
    let count = 0;
    reg.subscribe(() => { count++; });
    reg.setDisabledPlugins([]); // initial load with empty disabled set — must notify
    expect(count).toBe(1);
  });
});

// ─── Centralized filter invariant — one test per getter ─────────────────────
// These tests exist solely to prove that every getter routes through
// filterEnabled(). If a future getter forgets the call, adding it to the
// corresponding registration method will make its test fail-loud here.
describe('getters apply disabled-plugin filter', () => {
  let reg: PluginFrontendRegistry;

  beforeEach(() => {
    reg = new PluginFrontendRegistry();
  });

  it('getNavItems filters disabled plugins', () => {
    reg.registerNav('plugin-a', [{ group: 'g', label: 'A', path: '/a', icon: 'box' }]);
    reg.setDisabledPlugins(['plugin-a']);
    expect(reg.getNavItems()).toHaveLength(0);
  });

  it('getPages filters disabled plugins', () => {
    reg.registerPages('plugin-a', [{ path: '/a', component: () => null as any }]);
    reg.setDisabledPlugins(['plugin-a']);
    expect(reg.getPages()).toHaveLength(0);
  });

  it('getCommands filters disabled plugins', () => {
    reg.registerCommands('plugin-a', [{ id: 'cmd1', label: 'C', action: () => {} }]);
    reg.setDisabledPlugins(['plugin-a']);
    expect(reg.getCommands()).toHaveLength(0);
  });

  it('getDecoders filters disabled plugins', () => {
    const decoder = { id: 'dec1', name: 'Dec', detect: () => false, decodeFrames: () => [] };
    reg.registerDecoders('plugin-a', [decoder]);
    reg.setDisabledPlugins(['plugin-a']);
    expect(reg.getDecoders()).toHaveLength(0);
  });

  it('getAllSlots filters disabled plugins', () => {
    reg.registerUiSlots('plugin-a', [{ id: 'slot:x', kind: 'container', description: 'x' }]);
    reg.setDisabledPlugins(['plugin-a']);
    expect(reg.getAllSlots()).toHaveLength(0);
  });

  it('getSlotContributions filters disabled plugins', () => {
    const Comp = () => null;
    reg.registerUiContributions('plugin-a', [{ slot: 's', id: 'plugin-a:card', component: 'Card' }]);
    reg.registerContributionComponents('plugin-a', { Card: Comp });
    reg.setDisabledPlugins(['plugin-a']);
    expect(reg.getSlotContributions('s')).toHaveLength(0);
  });

  it('getButtonContributions filters disabled plugins', () => {
    reg.registerButtonContribution('plugin-a', { slot: 's', id: 'btn1', label: 'Btn', onClick: vi.fn() });
    reg.setDisabledPlugins(['plugin-a']);
    expect(reg.getButtonContributions('s')).toHaveLength(0);
  });

  it('getNavItemContributions filters disabled plugins', () => {
    reg.registerNavItemContribution('plugin-a', { slot: 's', id: 'nav1', label: 'Nav', to: '/nav' });
    reg.setDisabledPlugins(['plugin-a']);
    expect(reg.getNavItemContributions('s')).toHaveLength(0);
  });
});

describe('PluginFrontendRegistry — UI slots & contributions', () => {
  let reg: PluginFrontendRegistry;

  beforeEach(() => {
    reg = new PluginFrontendRegistry();
  });

  it('registerUiSlots and getAllSlots return registrations with plugin attribution', () => {
    reg.registerUiSlots('data-sync', [
      { id: 'data-sync:dashboard:footer', kind: 'container', description: 'below targets' },
    ]);
    expect(reg.getAllSlots()).toEqual([
      { id: 'data-sync:dashboard:footer', kind: 'container', description: 'below targets', plugin: 'data-sync' },
    ]);
  });

  it('registerUiContributions + registerContributionComponents + getSlotContributions resolves React components', () => {
    const Comp = () => null;
    reg.registerUiContributions('inspector', [
      { slot: 'data-sync:dashboard:footer', id: 'inspector:card', component: 'InspectorCard' },
    ]);
    reg.registerContributionComponents('inspector', { InspectorCard: Comp });
    const resolved = reg.getSlotContributions('data-sync:dashboard:footer');
    expect(resolved).toHaveLength(1);
    expect(resolved[0].id).toBe('inspector:card');
    expect(resolved[0].component).toBe(Comp);
  });

  it('getSlotContributions returns [] for unknown slot id', () => {
    expect(reg.getSlotContributions('nobody:nowhere')).toEqual([]);
  });

  it('getSlotContributions orders by priority asc, then declaration order', () => {
    // Semantics: missing `priority` = 0. Sort asc. Ties broken by declaration order.
    const A = () => null; const B = () => null; const C = () => null;
    reg.registerContributionComponents('p', { A, B, C });
    reg.registerUiContributions('p', [
      { slot: 's', id: 'p:a', component: 'A' },              // priority 0
      { slot: 's', id: 'p:b', component: 'B', priority: 1 },
      { slot: 's', id: 'p:c', component: 'C', priority: 10 },
    ]);
    expect(reg.getSlotContributions('s').map(c => c.id)).toEqual(['p:a', 'p:b', 'p:c']);
  });

  it('tie-breaks equal priorities by declaration order', () => {
    const A = () => null; const B = () => null;
    reg.registerContributionComponents('p', { A, B });
    reg.registerUiContributions('p', [
      { slot: 's', id: 'p:b', component: 'B', priority: 5 },
      { slot: 's', id: 'p:a', component: 'A', priority: 5 },
    ]);
    expect(reg.getSlotContributions('s').map(c => c.id)).toEqual(['p:b', 'p:a']);
  });

  it('contributions from disabled plugins are filtered out', () => {
    const Comp = () => null;
    reg.registerUiContributions('disabled-plug', [
      { slot: 's', id: 'dp:card', component: 'Card' },
    ]);
    reg.registerContributionComponents('disabled-plug', { Card: Comp });
    reg.setDisabledPlugins(['disabled-plug']);
    expect(reg.getSlotContributions('s')).toEqual([]);
  });

  it('slots from disabled plugins are filtered out of getAllSlots', () => {
    reg.registerUiSlots('disabled-plug', [
      { id: 'dp:x', kind: 'container', description: 'x' },
    ]);
    reg.setDisabledPlugins(['disabled-plug']);
    expect(reg.getAllSlots()).toEqual([]);
  });

  it('warns when a contribution targets a component key that was never registered', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    reg.registerUiContributions('p', [
      { slot: 's', id: 'p:x', component: 'NotRegistered' },
    ]);
    reg.getSlotContributions('s'); // triggers resolution
    expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/NotRegistered/));
    warnSpy.mockRestore();
  });
});

describe('PluginFrontendRegistry — button contributions', () => {
  let reg: PluginFrontendRegistry;
  beforeEach(() => { reg = new PluginFrontendRegistry(); });

  it('registerButtonContribution + getButtonContributions round-trips', () => {
    const fn = vi.fn();
    reg.registerButtonContribution('inspector', {
      slot: 'device-viewer:overflow', id: 'inspector:push',
      label: 'Push', icon: 'upload-cloud', onClick: fn,
    });
    const got = reg.getButtonContributions('device-viewer:overflow');
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({
      id: 'inspector:push', label: 'Push', icon: 'upload-cloud', plugin: 'inspector',
    });
    expect(got[0].onClick).toBe(fn);
  });

  it('getButtonContributions returns [] for unknown slot', () => {
    expect(reg.getButtonContributions('nope')).toEqual([]);
  });

  it('getButtonContributions sorts by priority asc, then registration order', () => {
    const a = vi.fn(); const b = vi.fn(); const c = vi.fn();
    reg.registerButtonContribution('p', { slot: 's', id: 'a', label: 'a', onClick: a });            // priority 0
    reg.registerButtonContribution('p', { slot: 's', id: 'b', label: 'b', onClick: b, priority: 1 });
    reg.registerButtonContribution('p', { slot: 's', id: 'c', label: 'c', onClick: c, priority: 10 });
    expect(reg.getButtonContributions('s').map(x => x.id)).toEqual(['a', 'b', 'c']);
  });

  it('tie-breaks equal priorities by registration order', () => {
    reg.registerButtonContribution('p', { slot: 's', id: 'b', label: 'b', onClick: vi.fn(), priority: 5 });
    reg.registerButtonContribution('p', { slot: 's', id: 'a', label: 'a', onClick: vi.fn(), priority: 5 });
    expect(reg.getButtonContributions('s').map(x => x.id)).toEqual(['b', 'a']);
  });

  it('filters out contributions from disabled plugins', () => {
    reg.registerButtonContribution('disabled-plug', { slot: 's', id: 'x', label: 'x', onClick: vi.fn() });
    reg.setDisabledPlugins(['disabled-plug']);
    expect(reg.getButtonContributions('s')).toEqual([]);
  });
});

describe('PluginFrontendRegistry — nav-item contributions', () => {
  let reg: PluginFrontendRegistry;
  beforeEach(() => { reg = new PluginFrontendRegistry(); });

  it('registerNavItemContribution + getNavItemContributions round-trips', () => {
    reg.registerNavItemContribution('data-sync', {
      slot: 'core:settings:tabs', id: 'data-sync:tab',
      label: 'Data Sync', to: '/settings/data-sync', icon: 'database',
    });
    const got = reg.getNavItemContributions('core:settings:tabs');
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({
      id: 'data-sync:tab', label: 'Data Sync', to: '/settings/data-sync', plugin: 'data-sync',
    });
  });

  it('filters by disabled plugin', () => {
    reg.registerNavItemContribution('dp', { slot: 's', id: 'x', label: 'x', to: '/x' });
    reg.setDisabledPlugins(['dp']);
    expect(reg.getNavItemContributions('s')).toEqual([]);
  });

  it('sorts by priority', () => {
    reg.registerNavItemContribution('p', { slot: 's', id: 'a', label: 'a', to: '/a' });
    reg.registerNavItemContribution('p', { slot: 's', id: 'b', label: 'b', to: '/b', priority: -1 });
    expect(reg.getNavItemContributions('s').map(x => x.id)).toEqual(['b', 'a']);
  });
});
