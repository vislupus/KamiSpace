// Lucide icons, imported individually so only the ones in use are bundled.
import {
  AlignCenter, AlignLeft, AppWindow, Archive, ArrowUpDown, CircleChevronDown, CircleDashed,
  EyeOff, Hash, ListFilter, SquareCheck, SquareKanban, ArrowDown, ArrowUp, AtSign, AudioLines, Baseline, Bookmark, Calendar,
  Captions, CircleCheckBig, ClipboardCopy, Columns2, FileDown, FileUp, Globe, Highlighter, Library,
  ListCollapse, LockOpen, MoveVertical, Sigma, Video, BetweenHorizontalStart, BetweenVerticalStart, Bold, Building2,
  Check, ChevronDown, ChevronLeft, ChevronRight, ChevronsLeft, CircleAlert, CircleCheck, Clock, CloudOff, Code,
  Columns3, Copy, CornerDownLeft, Database, Download, Ellipsis, ExternalLink, Eye, File, FileImage,
  FileSpreadsheet, FileText, FolderInput, GripVertical, Heading1, Heading2, Heading3, History,
  Home, Image, ImagePlus, Inbox, Info, Italic, KeyRound, Link, List, ListOrdered, ListTodo,
  LoaderCircle, Lock, LogOut, Maximize2, Menu, Minimize2, Minus, Monitor, Moon, PanelLeft,
  Paperclip, Pencil, Plus, RefreshCw, RotateCcw, Rows3, Search, Settings, Shield, Smile,
  SquareCode, SquarePen, Star, StickyNote, Strikethrough, Sun, Table, TextQuote, Trash, Trash2,
  TriangleAlert, Type, Underline, Unlink, Upload, User, UserPlus, Users, X, Zap, createElement,
} from 'lucide';

const ICONS = {
  align: AlignCenter, caption: Captions, embed: AppWindow,
  'align-left': AlignLeft, sort: ArrowUpDown, select: CircleChevronDown, status: CircleDashed,
  'eye-off': EyeOff, hash: Hash, filter: ListFilter, checkbox: SquareCheck, kanban: SquareKanban, archive: Archive, 'arrow-down': ArrowDown, 'arrow-up': ArrowUp, at: AtSign,
  audio: AudioLines, 'text-color': Baseline, bookmark: Bookmark, calendar: Calendar,
  tasks: CircleCheckBig, 'clipboard-copy': ClipboardCopy, 'columns-2': Columns2,
  'file-down': FileDown, 'file-up': FileUp, globe: Globe, highlighter: Highlighter,
  library: Library, toggle: ListCollapse, unlock: LockOpen, reposition: MoveVertical,
  equation: Sigma, video: Video,
  'row-add': BetweenHorizontalStart, 'column-add': BetweenVerticalStart, bold: Bold,
  building: Building2, check: Check, 'chevron-down': ChevronDown, 'chevron-left': ChevronLeft,
  'chevron-right': ChevronRight,
  'chevrons-left': ChevronsLeft, alert: CircleAlert, 'check-circle': CircleCheck, clock: Clock,
  offline: CloudOff, code: Code, columns: Columns3, copy: Copy, enter: CornerDownLeft,
  database: Database, download: Download, more: Ellipsis, external: ExternalLink, eye: Eye,
  file: File, 'file-image': FileImage, 'file-sheet': FileSpreadsheet, 'file-text': FileText,
  move: FolderInput, grip: GripVertical, h1: Heading1, h2: Heading2, h3: Heading3,
  history: History, home: Home, image: Image, 'image-plus': ImagePlus, inbox: Inbox, info: Info,
  italic: Italic, key: KeyRound, link: Link, list: List, 'list-ordered': ListOrdered,
  'list-todo': ListTodo, loader: LoaderCircle, lock: Lock, logout: LogOut, maximize: Maximize2,
  menu: Menu, minimize: Minimize2, minus: Minus, monitor: Monitor, moon: Moon,
  sidebar: PanelLeft, paperclip: Paperclip, pencil: Pencil, plus: Plus, refresh: RefreshCw,
  restore: RotateCcw, rows: Rows3, search: Search, settings: Settings, shield: Shield,
  smile: Smile, 'code-block': SquareCode, compose: SquarePen, star: Star, note: StickyNote,
  strike: Strikethrough, sun: Sun, table: Table, quote: TextQuote, trash: Trash,
  'trash-2': Trash2, warning: TriangleAlert, text: Type, underline: Underline, unlink: Unlink,
  upload: Upload, user: User, 'user-plus': UserPlus, users: Users, x: X, zap: Zap,
};

/** Returns a fresh <svg> element for the named icon. */
export function icon(name, size = 16) {
  const node = ICONS[name] ?? ICONS.file;
  const svg = createElement(node, {
    width: size,
    height: size,
    'stroke-width': 1.75,
    'aria-hidden': 'true',
  });
  svg.classList.add('icon');
  return svg;
}
