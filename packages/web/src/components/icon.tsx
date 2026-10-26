// Icons by name: Lucide names ("globe", "brain", "arrow-up-right") or an emoji.
// Common icons are bundled; any other Lucide icon is loaded lazily from a separate chunk.

import { useEffect, useState, type ComponentType } from "react";
import {
  Activity,
  Bell,
  BookOpen,
  Bot,
  Brain,
  Calendar,
  ChartBar,
  Check,
  CircleAlert,
  Clock,
  Cloud,
  Code,
  Compass,
  Cpu,
  Database,
  Eye,
  File,
  FileText,
  FlaskConical,
  Folder,
  GitBranch,
  Globe,
  Hammer,
  Heart,
  House,
  Image,
  Inbox,
  Info,
  Key,
  Laptop,
  LayoutDashboard,
  Lightbulb,
  Link,
  ListChecks,
  ListTodo,
  Lock,
  Mail,
  Map as MapIcon,
  MessageSquare,
  MessagesSquare,
  Monitor,
  Newspaper,
  Notebook,
  PanelRight,
  Pencil,
  Play,
  Plug,
  Plus,
  Power,
  Puzzle,
  RefreshCw,
  Rocket,
  Rss,
  Search,
  Send,
  Server,
  Settings,
  Shield,
  ShieldCheck,
  Smartphone,
  Sparkles,
  Star,
  Terminal,
  Trash2,
  TriangleAlert,
  User,
  Users,
  Webhook,
  Wifi,
  Workflow,
  Wrench,
  X,
  Zap,
  type LucideProps,
} from "lucide-react";

type IconComponent = ComponentType<LucideProps>;

const BUNDLED: Record<string, IconComponent> = {
  activity: Activity,
  bell: Bell,
  "book-open": BookOpen,
  bot: Bot,
  brain: Brain,
  calendar: Calendar,
  "chart-bar": ChartBar,
  "bar-chart": ChartBar,
  check: Check,
  "circle-alert": CircleAlert,
  "alert-circle": CircleAlert,
  clock: Clock,
  cloud: Cloud,
  code: Code,
  compass: Compass,
  cpu: Cpu,
  database: Database,
  eye: Eye,
  file: File,
  "file-text": FileText,
  "flask-conical": FlaskConical,
  folder: Folder,
  "git-branch": GitBranch,
  globe: Globe,
  hammer: Hammer,
  heart: Heart,
  house: House,
  home: House,
  image: Image,
  inbox: Inbox,
  info: Info,
  key: Key,
  laptop: Laptop,
  "layout-dashboard": LayoutDashboard,
  lightbulb: Lightbulb,
  link: Link,
  "list-checks": ListChecks,
  "list-todo": ListTodo,
  lock: Lock,
  mail: Mail,
  map: MapIcon,
  "message-square": MessageSquare,
  "messages-square": MessagesSquare,
  monitor: Monitor,
  newspaper: Newspaper,
  notebook: Notebook,
  "panel-right": PanelRight,
  pencil: Pencil,
  play: Play,
  plug: Plug,
  plus: Plus,
  power: Power,
  puzzle: Puzzle,
  "refresh-cw": RefreshCw,
  rocket: Rocket,
  rss: Rss,
  search: Search,
  send: Send,
  server: Server,
  settings: Settings,
  shield: Shield,
  "shield-check": ShieldCheck,
  smartphone: Smartphone,
  sparkles: Sparkles,
  star: Star,
  terminal: Terminal,
  "trash-2": Trash2,
  trash: Trash2,
  "triangle-alert": TriangleAlert,
  "alert-triangle": TriangleAlert,
  user: User,
  users: Users,
  webhook: Webhook,
  wifi: Wifi,
  workflow: Workflow,
  wrench: Wrench,
  x: X,
  zap: Zap,
};

const lazyCache = new Map<string, IconComponent | null>();
let allIcons: Promise<Record<string, IconComponent>> | undefined;

function pascal(name: string): string {
  return name
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((s) => s[0].toUpperCase() + s.slice(1))
    .join("");
}

function isIconName(name: string): boolean {
  return /^[A-Za-z][A-Za-z0-9-_]*$/.test(name);
}

export function Icon({ name, className, fallback = Puzzle }: { name?: string; className?: string; fallback?: IconComponent }) {
  const key = (name ?? "").trim();
  const bundled = BUNDLED[key.toLowerCase()];
  const [lazy, setLazy] = useState<IconComponent | null | undefined>(() => (bundled ? undefined : lazyCache.get(key)));

  useEffect(() => {
    if (bundled || !key || !isIconName(key) || lazyCache.has(key)) return;
    let alive = true;
    allIcons ??= import("./all-icons").then((m) => m.icons as Record<string, IconComponent>);
    allIcons
      .then((icons) => {
        const c = icons[pascal(key)] ?? icons[key] ?? null;
        lazyCache.set(key, c);
        if (alive) setLazy(() => c);
      })
      .catch(() => lazyCache.set(key, null));
    return () => {
      alive = false;
    };
  }, [key, bundled]);

  if (key && !isIconName(key)) {
    // Emoji or other symbol.
    return (
      <span className={className} style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", lineHeight: 1 }} aria-hidden>
        {key}
      </span>
    );
  }
  const C = bundled ?? lazy ?? fallback;
  return <C className={className} aria-hidden />;
}
