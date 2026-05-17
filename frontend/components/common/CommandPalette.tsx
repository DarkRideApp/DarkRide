import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  LayoutDashboard,
  Smartphone,
  Zap,
  History,
  Shield,
  Send,
  Activity,
  Crosshair,
  BookOpen,
  Wrench,
  Play,
  Timer,
  Download,
  Bug,
  Cloud,
  KeyRound,
  Settings,
  Search,
  Plus,
  Package,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useWebSocket } from '@darkrideapp/plugin-sdk/react';
import { pluginRegistry, usePluginRegistrySnapshot } from '@darkrideapp/plugin-sdk/react';
import { resolveIcon } from '@darkrideapp/plugin-sdk/react';

interface CommandItem {
  id: string;
  label: string;
  category: string;
  icon: LucideIcon;
  keywords: string[];
  action: () => void;
  badge?: string;
}

function buildItems(navigate: ReturnType<typeof useNavigate>, pluginCommands: ReturnType<typeof pluginRegistry.getCommands>): CommandItem[] {
  const items: CommandItem[] = [
    // Pages
    {
      id: 'page-dashboard',
      label: 'Dashboard',
      category: 'Pages',
      icon: LayoutDashboard,
      keywords: ['home', 'overview', 'main'],
      action: () => navigate('/ui/'),
    },
    {
      id: 'page-devices',
      label: 'Devices',
      category: 'Pages',
      icon: Smartphone,
      keywords: ['phone', 'android', 'ios', 'adb', 'mobile', 'connected'],
      action: () => navigate('/ui/devices'),
    },
    {
      id: 'page-automations',
      label: 'Automations',
      category: 'Pages',
      icon: Zap,
      keywords: ['automation', 'script', 'rule', 'bot', 'task', 'workflow'],
      action: () => navigate('/ui/automations'),
    },
    {
      id: 'page-sessions',
      label: 'Sessions',
      category: 'Pages',
      icon: History,
      keywords: ['session', 'run', 'history', 'log', 'execution'],
      action: () => navigate('/ui/sessions'),
    },
    {
      id: 'page-proxies',
      label: 'Proxies',
      category: 'Pages',
      icon: Shield,
      keywords: ['proxy', 'vpn', 'nordvpn', 'socks', 'wireguard', 'tunnel'],
      action: () => navigate('/ui/proxies'),
    },
    {
      id: 'page-http-requests',
      label: 'HTTP Requests',
      category: 'Pages',
      icon: Send,
      keywords: ['http', 'request', 'capture', 'network', 'traffic', 'mitm', 'intercepted'],
      action: () => navigate('/ui/proxied-requests'),
    },
    {
      id: 'page-request-builder',
      label: 'Request Builder',
      category: 'Pages',
      icon: Play,
      keywords: ['request', 'builder', 'send', 'http', 'api', 'test', 'postman'],
      action: () => navigate('/ui/request-builder'),
    },
    {
      id: 'page-traffic',
      label: 'Traffic',
      category: 'Pages',
      icon: Activity,
      keywords: ['traffic', 'network', 'capture', 'http', 'monitor', 'live', 'websocket'],
      action: () => navigate('/ui/traffic'),
    },
    {
      id: 'page-api-catalogue',
      label: 'API Catalogue',
      category: 'Pages',
      icon: BookOpen,
      keywords: ['api', 'catalogue', 'catalog', 'endpoints', 'docs', 'documentation'],
      action: () => navigate('/ui/api-catalogue'),
    },
    {
      id: 'page-selector-debugger',
      label: 'Selector Debugger',
      category: 'Pages',
      icon: Crosshair,
      keywords: ['selector', 'debugger', 'dom', 'xpath', 'css', 'element', 'inspect'],
      action: () => navigate('/ui/selector-debugger'),
    },
    {
      id: 'page-utils',
      label: 'Utils',
      category: 'Pages',
      icon: Wrench,
      keywords: ['utils', 'utilities', 'tools', 'helper'],
      action: () => navigate('/ui/utils'),
    },
    {
      id: 'page-apks',
      label: 'APKs',
      category: 'Pages',
      icon: Download,
      keywords: ['apk', 'app', 'android', 'package', 'install', 'analyze', 'diff'],
      action: () => navigate('/ui/apks'),
    },
    {
      id: 'page-frida',
      label: 'Frida',
      category: 'Pages',
      icon: Bug,
      keywords: ['frida', 'hook', 'inject', 'script', 'instrumentation', 'patch', 'dynamic'],
      action: () => navigate('/ui/frida'),
    },
    {
      id: 'page-cloud',
      label: 'Cloud Storage',
      category: 'Pages',
      icon: Cloud,
      keywords: ['cloud', 'storage', 'upload', 'files', 'bucket', 's3'],
      action: () => navigate('/ui/cloud'),
    },
    {
      id: 'page-credentials',
      label: 'Credentials',
      category: 'Pages',
      icon: KeyRound,
      keywords: ['credentials', 'password', 'login', 'auth', 'secret', 'keys'],
      action: () => navigate('/ui/credentials'),
    },
    {
      id: 'page-jobs',
      label: 'Jobs',
      category: 'Pages',
      icon: Timer,
      keywords: ['jobs', 'scheduled', 'cron', 'task', 'timer', 'queue'],
      action: () => navigate('/ui/jobs'),
    },
    {
      id: 'page-settings',
      label: 'Settings',
      category: 'Pages',
      icon: Settings,
      keywords: ['settings', 'config', 'configuration', 'preferences', 'setup'],
      action: () => navigate('/ui/settings'),
    },
    // Actions
    {
      id: 'action-new-automation',
      label: 'New Automation',
      category: 'Actions',
      icon: Plus,
      keywords: ['new', 'create', 'automation', 'add', 'script'],
      action: () => navigate('/ui/automations/new'),
    },
    {
      id: 'action-add-device',
      label: 'Add Device',
      category: 'Actions',
      icon: Smartphone,
      keywords: ['add', 'connect', 'device', 'phone', 'new', 'pair'],
      action: () => navigate('/ui/devices'),
    },
  ];

  // Plugin commands
  for (const cmd of pluginCommands) {
    items.push({
      id: cmd.id,
      label: cmd.label,
      category: 'Plugins',
      icon: resolveIcon(cmd.icon ?? 'plug'),
      keywords: cmd.keywords ?? [],
      action: cmd.action,
    });
  }

  return items;
}

interface DynamicCache {
  items: CommandItem[];
  fetchedAt: number;
}

const CACHE_TTL_MS = 30_000;

function matchesQuery(item: CommandItem, query: string): boolean {
  if (!query) return true;
  const q = query.toLowerCase();
  if (item.label.toLowerCase().includes(q)) return true;
  if (item.keywords.some(k => k.toLowerCase().includes(q))) return true;
  return false;
}

export function CommandPalette() {
  const navigate = useNavigate();
  const ws = useWebSocket();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [dynamicItems, setDynamicItems] = useState<CommandItem[]>([]);
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const resultsRef = useRef<HTMLDivElement>(null);
  const selectedItemRef = useRef<HTMLDivElement>(null);
  const cacheRef = useRef<DynamicCache | null>(null);

  const pluginCommands = usePluginRegistrySnapshot(r => r.getCommands());
  const staticItems = buildItems(navigate, pluginCommands);
  const allItems = [...staticItems, ...dynamicItems];
  const filteredItems = allItems.filter(item => matchesQuery(item, query));

  // Group filtered items by category
  const groups: Record<string, CommandItem[]> = {};
  for (const item of filteredItems) {
    if (!groups[item.category]) groups[item.category] = [];
    groups[item.category].push(item);
  }

  const fetchDynamicItems = useCallback(async () => {
    const now = Date.now();
    if (cacheRef.current && now - cacheRef.current.fetchedAt < CACHE_TTL_MS) {
      setDynamicItems(cacheRef.current.items);
      return;
    }

    setLoading(true);
    try {
      const [devicesRes, automationsRes, apksRes] = await Promise.allSettled([
        ws.sendRestApi('GET', '/v1/device/list'),
        ws.sendRestApi('GET', '/v1/automation/list'),
        ws.sendRestApi('GET', '/v1/apps/tracked'),
      ]);

      const items: CommandItem[] = [];

      if (devicesRes.status === 'fulfilled' && devicesRes.value.body?.data) {
        const devices: Array<{ id: string; name?: string; manufacturer?: string; model?: string; androidVersion?: string; platform?: string }> =
          devicesRes.value.body.data;
        for (const device of devices) {
          items.push({
            id: `device-${device.id}`,
            label: device.name || device.id,
            category: 'Devices',
            icon: Smartphone,
            keywords: [device.id, device.name, device.manufacturer, device.model].filter(Boolean) as string[],
            action: () => navigate(`/ui/devices/${encodeURIComponent(device.id)}`),
          });
        }
      }

      if (automationsRes.status === 'fulfilled' && automationsRes.value.body?.data) {
        const automations: Array<{ id: number | string; name: string; isRule?: boolean }> =
          automationsRes.value.body.data;
        for (const automation of automations) {
          items.push({
            id: `automation-${automation.id}`,
            label: automation.name,
            category: 'Automations',
            icon: Zap,
            keywords: [automation.name],
            badge: automation.isRule ? 'Rule' : undefined,
            action: () => navigate(`/ui/automations/${automation.id}/edit`),
          });
        }
      }

      if (apksRes.status === 'fulfilled' && apksRes.value.body?.data) {
        const apks: Array<{ id: number | string; packageName: string; appName?: string; latestVersion?: string }> =
          apksRes.value.body.data;
        for (const apk of apks) {
          items.push({
            id: `apk-${apk.id}`,
            label: apk.appName || apk.packageName,
            category: 'APKs',
            icon: Package,
            keywords: [apk.packageName, apk.appName].filter(Boolean) as string[],
            action: () => navigate('/ui/apks'),
          });
        }
      }

      cacheRef.current = { items, fetchedAt: Date.now() };
      setDynamicItems(items);
    } catch {
      // Gracefully degrade — show only static items
    } finally {
      setLoading(false);
    }
  }, [ws, navigate]);

  const openPalette = useCallback(() => {
    setOpen(true);
    setQuery('');
    setSelectedIndex(0);
  }, []);

  const closePalette = useCallback(() => {
    setOpen(false);
    setQuery('');
  }, []);

  const executeSelected = useCallback(() => {
    const item = filteredItems[selectedIndex];
    if (item) {
      item.action();
      closePalette();
    }
  }, [filteredItems, selectedIndex, closePalette]);

  // Fetch dynamic items when palette opens
  useEffect(() => {
    if (open) {
      fetchDynamicItems();
    }
  }, [open, fetchDynamicItems]);

  // Global keyboard shortcut to open
  useEffect(() => {
    const handleGlobalKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
        e.preventDefault();
        if (open) {
          closePalette();
        } else {
          openPalette();
        }
      }
    };
    document.addEventListener('keydown', handleGlobalKeyDown);
    return () => document.removeEventListener('keydown', handleGlobalKeyDown);
  }, [open, openPalette, closePalette]);

  // Navigation keys when palette is open
  useEffect(() => {
    if (!open) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        closePalette();
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedIndex(i => Math.min(i + 1, filteredItems.length - 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedIndex(i => Math.max(i - 1, 0));
      } else if (e.key === 'Enter') {
        e.preventDefault();
        executeSelected();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [open, closePalette, filteredItems.length, executeSelected]);

  // Auto-focus input when opened
  useEffect(() => {
    if (open) {
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [open]);

  // Reset selected index when query or results change
  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  // Scroll selected item into view
  useEffect(() => {
    if (selectedItemRef.current) {
      selectedItemRef.current.scrollIntoView({ block: 'nearest' });
    }
  }, [selectedIndex]);

  if (!open) return null;

  // Build flat index for selected tracking
  let flatIndex = 0;

  return (
    <div
      className="command-palette-overlay"
      onClick={closePalette}
      data-testid="command-palette-overlay"
    >
      <div
        className="command-palette"
        onClick={e => e.stopPropagation()}
        data-testid="command-palette"
      >
        <div className="command-palette-input-wrapper">
          <Search size={16} className="command-palette-search-icon" style={{ color: 'var(--text-muted)', flexShrink: 0 }} />
          <input
            ref={inputRef}
            className="command-palette-input"
            placeholder="Search pages and actions..."
            value={query}
            onChange={e => setQuery(e.target.value)}
            data-testid="command-palette-input"
            autoComplete="off"
            spellCheck={false}
          />
        </div>

        {loading && (
          <div className="command-palette-loading" data-testid="command-palette-loading" style={{ color: 'var(--text-muted)', padding: '6px 16px', fontSize: '0.8rem' }}>
            Loading...
          </div>
        )}

        <div className="command-palette-results" ref={resultsRef}>
          {filteredItems.length === 0 ? (
            <div className="command-palette-empty">No results for &ldquo;{query}&rdquo;</div>
          ) : (
            Object.entries(groups).map(([category, groupItems]) => (
              <div key={category} className="command-palette-group">
                <div className="command-palette-group-label">{category}</div>
                {groupItems.map(item => {
                  const currentIndex = flatIndex++;
                  const isSelected = currentIndex === selectedIndex;
                  return (
                    <div
                      key={item.id}
                      ref={isSelected ? selectedItemRef : undefined}
                      className={`command-palette-item${isSelected ? ' selected' : ''}`}
                      onClick={() => { item.action(); closePalette(); }}
                      onMouseEnter={() => setSelectedIndex(currentIndex)}
                      data-testid={`command-item-${item.id}`}
                    >
                      <item.icon size={16} className="item-icon" />
                      <span className="item-label">{item.label}</span>
                      {item.badge && (
                        <span className="item-badge" data-testid={`command-item-badge-${item.id}`}>{item.badge}</span>
                      )}
                      <span className="item-category">{category}</span>
                    </div>
                  );
                })}
              </div>
            ))
          )}
        </div>

        <div className="command-palette-footer">
          <span><kbd>↑</kbd><kbd>↓</kbd> Navigate</span>
          <span><kbd>Enter</kbd> Select</span>
          <span><kbd>Esc</kbd> Close</span>
        </div>
      </div>
    </div>
  );
}
