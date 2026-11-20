import {
  Activity,
  ArrowRight,
  ArrowUpRight,
  AtSign,
  Ban,
  Bell,
  BookOpen,
  Check,
  ChevronDown,
  ChevronRight,
  CircleCheck,
  CircleExclamationPoint,
  CircleX,
  Clock,
  Ellipsis,
  ExternalLink,
  Eye,
  EyeOff,
  FileText,
  FlaskConical,
  Flag,
  GitBranch,
  Globe,
  Hash,
  Inbox,
  Info,
  Lightbulb,
  LoaderCircle,
  Mail,
  Menu,
  MessagesSquare,
  MicVocal,
  Minus,
  Newspaper,
  Pause,
  Pencil,
  Play,
  Plus,
  Radio,
  RefreshCw,
  Rss,
  Search,
  Settings,
  Sparkles,
  Trash,
  TriangleExclamationPoint,
  Undo2,
  User,
  Video,
  X,
  type LucideIcon,
} from "lucide-react";

import type { SourceType } from "@/lib/types";

import { cn } from "./cn";

/** The icons of the app. Use a name, not a lucide component, so that the set stays small and consistent. */
export const ICONS = {
  activity: Activity,
  add: Plus,
  alert: TriangleExclamationPoint,
  arrowRight: ArrowRight,
  arrowUpRight: ArrowUpRight,
  ban: Ban,
  bell: Bell,
  book: BookOpen,
  check: Check,
  checkCircle: CircleCheck,
  chevronDown: ChevronDown,
  chevronRight: ChevronRight,
  clock: Clock,
  close: X,
  delete: Trash,
  edit: Pencil,
  error: CircleExclamationPoint,
  external: ExternalLink,
  failed: CircleX,
  flag: Flag,
  hide: EyeOff,
  idea: Lightbulb,
  inbox: Inbox,
  info: Info,
  menu: Menu,
  minus: Minus,
  more: Ellipsis,
  newspaper: Newspaper,
  pause: Pause,
  radio: Radio,
  refresh: RefreshCw,
  resume: Play,
  search: Search,
  settings: Settings,
  show: Eye,
  sparkles: Sparkles,
  spinner: LoaderCircle,
  undo: Undo2,
  user: User,
  warning: TriangleExclamationPoint,
} satisfies Record<string, LucideIcon>;

export type IconName = keyof typeof ICONS;

/** One icon per source type (specification §6.1). */
export const SOURCE_TYPE_ICONS: Record<SourceType, LucideIcon> = {
  x_user: AtSign,
  x_search: Hash,
  podcast: MicVocal,
  blog: Rss,
  github: GitBranch,
  docs: FileText,
  newsletter: Mail,
  youtube: Video,
  community: MessagesSquare,
  research: FlaskConical,
  web_search: Globe,
};

export interface IconProps {
  name: IconName;
  /** Size in px (default 16). */
  size?: number;
  className?: string;
  /** A text alternative. Without it the icon is decorative (aria-hidden): give the text next to it. */
  label?: string;
}

/** An icon of the kit. Icons are extra: a control always has a text label too. */
export function Icon({ name, size = 16, className, label }: IconProps) {
  const Component = ICONS[name];
  return (
    <Component
      size={size}
      strokeWidth={1.75}
      className={cn("inline-block shrink-0", className)}
      aria-hidden={label ? undefined : true}
      aria-label={label}
      role={label ? "img" : undefined}
      focusable="false"
    />
  );
}

/** The icon of a source type. Decorative unless `label` is set. */
export function SourceTypeIcon({
  type,
  size = 16,
  className,
  label,
}: {
  type: SourceType;
  size?: number;
  className?: string;
  label?: string;
}) {
  const Component = SOURCE_TYPE_ICONS[type];
  return (
    <Component
      size={size}
      strokeWidth={1.75}
      className={cn("inline-block shrink-0", className)}
      aria-hidden={label ? undefined : true}
      aria-label={label}
      role={label ? "img" : undefined}
      focusable="false"
    />
  );
}
