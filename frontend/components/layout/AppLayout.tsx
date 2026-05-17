import React, { useState, useCallback, useEffect } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { LiveLogPanel } from './LiveLogPanel';
import { AiChatDrawer } from '../ai/AiChatDrawer';
import { CommandPalette } from '../common/CommandPalette';
import { KeyboardShortcutsHelp, KeyboardShortcutsButton } from '@darkrideapp/plugin-sdk/react';
import { pluginRegistry, usePluginRegistrySnapshot } from '@darkrideapp/plugin-sdk/react';
import { resolveIcon } from '@darkrideapp/plugin-sdk/react';
import { useAuthOptional } from '@darkrideapp/plugin-sdk/react';
import { usePluginUpdateCount } from '../../hooks/usePluginUpdateCount';
import {
  LayoutDashboard,
  Smartphone,
  Zap,
  History,
  Send,
  Activity,
  Crosshair,
  BookOpen,
  Play,
  Download,
  Bug,
  Package,
  Settings,
  Users,
  User,
  PanelLeftClose,
  PanelLeftOpen,
  Menu,
  X,
  ChevronDown,
  Moon,
  Sun,
  LogOut,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  end?: boolean;
  requiredScope?: string;
  /** Force-active when the current pathname starts with one of these prefixes. */
  extraActivePaths?: string[];
  /** Force-inactive when the current pathname starts with one of these prefixes. */
  inactivePaths?: string[];
  /** Optional small numeric badge rendered next to the label. Falsy = no badge. */
  badge?: number | null;
}

interface NavGroup {
  label: string;
  items: NavItem[];
}

const CORE_NAV_GROUPS: NavGroup[] = [
  {
    label: 'Core',
    items: [
      { to: '/ui/', label: 'Dashboard', icon: LayoutDashboard, end: true },
      { to: '/ui/devices', label: 'Devices', icon: Smartphone, requiredScope: 'core.devices:read' },
      {
        to: '/ui/automations',
        label: 'Automations',
        icon: Zap,
        requiredScope: 'core.automations:read',
        // Session timelines live under /ui/automations/session/* but
        // conceptually belong to the Sessions nav.
        inactivePaths: ['/ui/automations/session/'],
      },
      {
        to: '/ui/sessions',
        label: 'Sessions',
        icon: History,
        requiredScope: 'core.automations:read',
        extraActivePaths: ['/ui/automations/session/'],
      },
    ],
  },
  {
    label: 'Network',
    items: [
      { to: '/ui/proxied-requests', label: 'HTTP Requests', icon: Send, requiredScope: 'core.traffic:read' },
      { to: '/ui/request-builder', label: 'Request Builder', icon: Play },
      { to: '/ui/traffic', label: 'Traffic', icon: Activity, requiredScope: 'core.traffic:read' },
      { to: '/ui/api-catalogue', label: 'API Catalogue', icon: BookOpen },
    ],
  },
  {
    label: 'Tools',
    items: [
      { to: '/ui/selector-debugger', label: 'Selector Debugger', icon: Crosshair },
      { to: '/ui/apks', label: 'APKs', icon: Download, requiredScope: 'core.apk:read' },
      { to: '/ui/frida', label: 'Frida', icon: Bug, requiredScope: 'core.frida:read' },
      // Marketplace is a top-level entry point — promoted out of Settings
      // because browsing/installing plugins is a frequent first-run action
      // and Settings is the wrong shelf for "browse apps". Old paths
      // /ui/settings/marketplace and /ui/settings/plugins/marketplace still
      // redirect here for back-compat. See ROADMAP §Plugin Ecosystem Polish.
      { to: '/ui/marketplace', label: 'Marketplace', icon: Package, requiredScope: 'core.plugins:manage' },
    ],
  },
  {
    label: 'Config',
    items: [
      { to: '/ui/settings', label: 'Settings', icon: Settings, requiredScope: 'core.settings:read' },
    ],
  },
];

const ADMIN_NAV_ITEM: NavItem = { to: '/ui/admin/users', label: 'Users', icon: Users };

function buildNavGroups(
  isAdmin: boolean,
  pluginNavItems: ReturnType<typeof pluginRegistry.getNavItems>,
  pluginUpdateCount: number,
): NavGroup[] {
  const groups = CORE_NAV_GROUPS.map((g) => {
    if (g.label === 'Config' && isAdmin) {
      return { label: g.label, items: [...g.items, ADMIN_NAV_ITEM] };
    }
    return { label: g.label, items: [...g.items] };
  });

  // Badge the Marketplace nav item with the available-update count so users
  // notice updates without having to open the page.
  if (pluginUpdateCount > 0) {
    for (const group of groups) {
      const marketplace = group.items.find(i => i.to === '/ui/marketplace');
      if (marketplace) {
        group.items = group.items.map(i =>
          i.to === '/ui/marketplace' ? { ...i, badge: pluginUpdateCount } : i,
        );
        break;
      }
    }
  }

  for (const item of pluginNavItems) {
    const group = groups.find((g) => g.label === item.group);
    if (group) {
      group.items.push({
        to: `/ui${item.path}`,
        label: item.label,
        icon: resolveIcon(item.icon),
        end: item.end,
      });
    } else {
      groups.push({
        label: item.group,
        items: [{
          to: `/ui${item.path}`,
          label: item.label,
          icon: resolveIcon(item.icon),
          end: item.end,
        }],
      });
    }
  }

  return groups;
}

const STORAGE_KEY = 'sidebar-collapsed-groups';

function loadCollapsedGroups(): string[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed;
    }
  } catch {
    // ignore
  }
  return [];
}

function saveCollapsedGroups(groups: string[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(groups));
  } catch {
    // ignore
  }
}

function getInitialTheme(): 'dark' | 'light' {
  try {
    const saved = localStorage.getItem('theme');
    if (saved === 'light' || saved === 'dark') return saved;
  } catch { /* ignore */ }
  return 'dark';
}

export function AppLayout() {
  const auth = useAuthOptional();
  const isAdmin = auth?.hasScope('core.users:admin') ?? false;
  const hasScope = (scope: string) => auth?.hasScope(scope) ?? true; // permissive if no auth
  // Wait for the disabled-plugin list to load before rendering plugin nav
  // items, otherwise disabled plugins (e.g. Kitchen Sink) flash briefly in
  // the sidebar between mount and the first /v1/plugins/states response.
  const pluginNavItems = usePluginRegistrySnapshot(r => r.isDisabledLoaded() ? r.getNavItems() : []);
  const pluginUpdateCount = usePluginUpdateCount();
  const navGroups = buildNavGroups(isAdmin, pluginNavItems, pluginUpdateCount);
  const [collapsed, setCollapsed] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [aiDrawerOpen, setAiDrawerOpen] = useState(false);
  const [collapsedGroups, setCollapsedGroups] = useState<string[]>(loadCollapsedGroups);
  const [theme, setTheme] = useState<'dark' | 'light'>(getInitialTheme);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const location = useLocation();

  // Apply theme to document
  React.useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    try { localStorage.setItem('theme', theme); } catch { /* ignore */ }
  }, [theme]);

  const toggleTheme = useCallback(() => setTheme(t => t === 'dark' ? 'light' : 'dark'), []);

  const closeMobileMenu = useCallback(() => setMobileMenuOpen(false), []);

  // Listen for AI drawer open/close to shrink main content on desktop
  React.useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      setAiDrawerOpen(detail?.open ?? false);
    };
    window.addEventListener('ai-drawer-toggle', handler);
    return () => window.removeEventListener('ai-drawer-toggle', handler);
  }, []);

  const toggleGroup = useCallback((groupLabel: string) => {
    setCollapsedGroups(prev => {
      const next = prev.includes(groupLabel)
        ? prev.filter(g => g !== groupLabel)
        : [...prev, groupLabel];
      saveCollapsedGroups(next);
      return next;
    });
  }, []);

  // Close mobile menu on navigation
  React.useEffect(() => {
    setMobileMenuOpen(false);
  }, [location.pathname]);

  // Open keyboard shortcuts help with "?"
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key !== '?') return;
      const target = e.target as HTMLElement;
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return;
      if (target.isContentEditable) return;
      setShortcutsOpen(v => !v);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  const sidebarNav = (
    <div className="sidebar-nav" role="navigation" aria-label="Main navigation">
      {navGroups.map((group, groupIndex) => {
        const isCollapsible = group.label !== 'Core';
        const isGroupCollapsed = isCollapsible && collapsedGroups.includes(group.label);
        return (
          <React.Fragment key={groupIndex}>
            {groupIndex > 0 && <div className="nav-separator" />}
            <div className="nav-group" role="group" aria-label={group.label}>
              {groupIndex > 0 && (
                <div
                  className="nav-group-label"
                  onClick={isCollapsible ? () => toggleGroup(group.label) : undefined}
                  onKeyDown={isCollapsible ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleGroup(group.label); } } : undefined}
                  role={isCollapsible ? 'button' : undefined}
                  tabIndex={isCollapsible ? 0 : undefined}
                  aria-expanded={isCollapsible ? !isGroupCollapsed : undefined}
                >
                  {group.label}
                  {isCollapsible && (
                    <ChevronDown
                      size={12}
                      className={`nav-group-chevron${isGroupCollapsed ? ' collapsed' : ''}`}
                    />
                  )}
                </div>
              )}
              <div className={`nav-group-items${isGroupCollapsed ? ' collapsed' : ''}`}>
                {group.items.filter(item => !item.requiredScope || hasScope(item.requiredScope)).map(item => (
                  <NavLink
                    key={item.to}
                    to={item.to}
                    end={item.end}
                    title={item.badge ? `${item.label} — ${item.badge} update${item.badge === 1 ? '' : 's'} available` : item.label}
                    className={({ isActive }) => {
                      let active = isActive;
                      if (item.extraActivePaths?.some(p => location.pathname.startsWith(p))) active = true;
                      if (item.inactivePaths?.some(p => location.pathname.startsWith(p))) active = false;
                      return active ? 'active' : '';
                    }}
                  >
                    <span className="nav-icon"><item.icon size={18} /></span>
                    <span className="nav-label">{item.label}</span>
                    {item.badge ? <span className="nav-badge" aria-label={`${item.badge} update${item.badge === 1 ? '' : 's'} available`}>{item.badge}</span> : null}
                  </NavLink>
                ))}
              </div>
            </div>
          </React.Fragment>
        );
      })}
    </div>
  );

  return (
    <div className={`app-layout${aiDrawerOpen ? ' ai-drawer-open' : ''}`}>
      <a href="#main-content" className="skip-to-content">Skip to content</a>
      {/* Mobile top bar */}
      <div className="mobile-topbar">
        <button className="mobile-menu-btn" onClick={() => setMobileMenuOpen(o => !o)} aria-label="Menu">
          {mobileMenuOpen ? <X size={22} /> : <Menu size={22} />}
        </button>
        <span className="mobile-topbar-title">DarkRide</span>
      </div>

      {/* Mobile drawer overlay */}
      {mobileMenuOpen && <div className="mobile-overlay" onClick={closeMobileMenu} />}

      {/* Sidebar — desktop: always visible; mobile: slide-in drawer */}
      <nav className={`sidebar ${collapsed ? 'collapsed' : ''} ${mobileMenuOpen ? 'mobile-open' : ''}`} data-testid="sidebar">
        <div className="sidebar-header">
          <span className="logo-text">DarkRide</span>
          <button
            className="sidebar-toggle"
            onClick={() => setCollapsed(c => !c)}
            aria-label="Toggle sidebar"
          >
            {collapsed ? <PanelLeftOpen size={18} /> : <PanelLeftClose size={18} />}
          </button>
        </div>
        {/*!collapsed && (
          <span className="sidebar-version">V 4.2.0-Alpha</span>
        )*/}
        {sidebarNav}
        <div className="sidebar-footer">
          {!collapsed && (
            <div className="sidebar-footer-user">
              <div className="sidebar-identity-avatar">DR</div>
              <div className="sidebar-identity-info">
                <span className="sidebar-identity-name">{auth?.user?.username ?? 'DarkRide'}</span>
                <span className="sidebar-identity-sub">{auth?.user ? 'Signed in' : 'Local Instance'}</span>
              </div>
            </div>
          )}
          <div className="sidebar-footer-actions">
            <button
              className="btn-icon"
              onClick={toggleTheme}
              title={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
              aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
            >
              {theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}
            </button>
            {auth && (
              <>
                <NavLink to="/ui/profile" className="btn-icon" title="My profile" aria-label="My profile">
                  <User size={16} />
                </NavLink>
                <button
                  className="btn-icon"
                  onClick={auth.logout}
                  title={`Sign out${auth.user ? ` (${auth.user.username})` : ''}`}
                  aria-label={`Sign out${auth.user ? ` (${auth.user.username})` : ''}`}
                >
                  <LogOut size={16} />
                </button>
              </>
            )}
          </div>
        </div>
      </nav>
      <div className="main-content">
        <div id="main-content" className="page-content">
          <Outlet />
        </div>
      </div>
      <LiveLogPanel />
      <AiChatDrawer />
      <CommandPalette />
      <KeyboardShortcutsButton onClick={() => setShortcutsOpen(true)} />
      {shortcutsOpen && <KeyboardShortcutsHelp onClose={() => setShortcutsOpen(false)} />}
    </div>
  );
}
