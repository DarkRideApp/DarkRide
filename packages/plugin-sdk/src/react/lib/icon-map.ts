import {
  Box, Map, Database, Navigation, FlaskConical, Wrench, Globe,
  FileText, Shield, Radio, BarChart, Bell, Clock, Code, Cpu,
  Download, Eye, FileSearch, Folder, GitBranch, Hash, Key,
  Layers, Link, Lock, Mail, MessageSquare, Monitor, Package,
  Plug, Search, Server, Settings, Star, Tag, Terminal, Upload,
  Users, Wifi, Zap, type LucideIcon,
} from 'lucide-react';

const ICON_MAP: Record<string, LucideIcon> = {
  box: Box, map: Map, database: Database, navigation: Navigation,
  'flask-conical': FlaskConical, wrench: Wrench, globe: Globe,
  'file-text': FileText, shield: Shield, radio: Radio,
  'bar-chart': BarChart, bell: Bell, clock: Clock, code: Code,
  cpu: Cpu, download: Download, eye: Eye, 'file-search': FileSearch,
  folder: Folder, 'git-branch': GitBranch, hash: Hash, key: Key,
  layers: Layers, link: Link, lock: Lock, mail: Mail,
  'message-square': MessageSquare, monitor: Monitor, package: Package,
  plug: Plug, search: Search, server: Server, settings: Settings,
  star: Star, tag: Tag, terminal: Terminal, upload: Upload,
  users: Users, wifi: Wifi, zap: Zap,
};

export function resolveIcon(name: string): LucideIcon {
  return ICON_MAP[name] ?? Box;
}
