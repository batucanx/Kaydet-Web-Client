/**
 * Kaydet design tokens — the single source of truth for the web client.
 *
 * Every value marked "mobile" is copied from the Flutter app:
 *   C:\Projects\KAYDET\lib\ui\core\theme\tokens.dart   (colors, spacing, radii, motion, dimens)
 *   C:\Projects\KAYDET\lib\ui\core\theme\app_theme.dart (typography)
 * The docs/plan/04-tasarim-sistemi.md file is STALE (Inter, slate palette); the Dart code wins.
 *
 * Values marked "web" are documented adaptations that do not exist on mobile.
 * Raw color literals are allowed ONLY in this file.
 */

export const themeNames = ['light', 'dark'] as const;
export type ThemeName = (typeof themeNames)[number];

/** Semantic colors. mobile: KaydetTokens.light / KaydetTokens.dark. */
export interface ColorTokens {
  bg: string;
  appBarBg: string;
  readingBg: string;
  surface: string;
  surfaceElevated: string;
  surfaceDeep: string;
  textPrimary: string;
  textSecondary: string;
  textTertiary: string;
  accent: string;
  accentFill: string;
  onAccentFill: string;
  accentSubtle: string;
  accentStrong: string;
  danger: string;
  dangerFill: string;
  success: string;
  warning: string;
  divider: string;
  border: string;
  scrim: string;
  /** mobile: `KaydetTokens.pinIcon` (black in light, `warning` in dark). */
  pinIcon: string;
  /** mobile: text/icon color on the app bar (`onAppBar` in app_theme.dart). */
  onAppBar: string;
  /** mobile: `Colors.white` on `dangerFill` (ColorScheme.onError). */
  onDangerFill: string;
}

export const colors: Record<ThemeName, ColorTokens> = {
  light: {
    bg: '#FFFFFF',
    appBarBg: '#1478C9',
    readingBg: '#FFFFFF',
    surface: '#F6F8F9',
    surfaceElevated: '#FFFFFF',
    surfaceDeep: '#EEF2F4',
    textPrimary: '#202124',
    textSecondary: '#6B6F73',
    textTertiary: '#9AA0A6',
    accent: '#1478C9',
    accentFill: '#1478C9',
    onAccentFill: '#FFFFFF',
    accentSubtle: '#1478C91F',
    accentStrong: '#075A9C',
    danger: '#C62A2F',
    dangerFill: '#C62A2F',
    success: '#1A7F4B',
    warning: '#B26A00',
    divider: '#E5E7EB',
    border: '#E5E7EB',
    scrim: '#00000073',
    pinIcon: '#000000',
    onAppBar: '#FFFFFF',
    onDangerFill: '#FFFFFF',
  },
  dark: {
    bg: '#131314',
    appBarBg: '#1E1F20',
    readingBg: '#2A2A2A',
    surface: '#1E1F20',
    surfaceElevated: '#282A2C',
    surfaceDeep: '#1E1F20',
    textPrimary: '#E3E3E3',
    textSecondary: '#C4C7C5',
    textTertiary: '#8E918F',
    accent: '#A8C7FA',
    accentFill: '#0B57D0',
    onAccentFill: '#FFFFFF',
    accentSubtle: '#1A3556',
    accentStrong: '#0B57D0',
    danger: '#F28B82',
    dangerFill: '#C5221F',
    success: '#81C995',
    warning: '#FDD663',
    divider: '#37393B',
    border: '#444746',
    scrim: '#0000008C',
    pinIcon: '#FDD663',
    onAppBar: '#E3E3E3',
    onDangerFill: '#FFFFFF',
  },
};

export interface AvatarTone {
  bg: string;
  fg: string;
}

/** mobile: KaydetTokens._lightAvatarTones / _darkAvatarTones (15 tones, letter/background >= 6:1). */
export const avatarTones: Record<ThemeName, readonly AvatarTone[]> = {
  light: [
    { bg: '#F0DCDB', fg: '#6F2520' },
    { bg: '#F0E1DB', fg: '#6F3820' },
    { bg: '#F0E6DB', fg: '#6F4A20' },
    { bg: '#F0EBDB', fg: '#6F5B20' },
    { bg: '#EFF0DB', fg: '#6C6F20' },
    { bg: '#E6F0DB', fg: '#4A6F20' },
    { bg: '#DBF0E2', fg: '#206F3A' },
    { bg: '#DBF0EC', fg: '#206F5F' },
    { bg: '#DBEDF0', fg: '#20646F' },
    { bg: '#DBE7F0', fg: '#204E6F' },
    { bg: '#DBDEF0', fg: '#202B6F' },
    { bg: '#E1DBF0', fg: '#38206F' },
    { bg: '#EBDBF0', fg: '#5B206F' },
    { bg: '#F0DBEC', fg: '#6F205F' },
    { bg: '#F0DBE3', fg: '#6F203D' },
  ],
  dark: [
    { bg: '#56312E', fg: '#E8B4B0' },
    { bg: '#563A2E', fg: '#E8C1B0' },
    { bg: '#56442E', fg: '#E8CEB0' },
    { bg: '#564C2E', fg: '#E8DAB0' },
    { bg: '#55562E', fg: '#E6E8B0' },
    { bg: '#44562E', fg: '#CEE8B0' },
    { bg: '#2E563C', fg: '#B0E8C3' },
    { bg: '#2E564E', fg: '#B0E8DD' },
    { bg: '#2E5156', fg: '#B0E1E8' },
    { bg: '#2E4656', fg: '#B0D1E8' },
    { bg: '#2E3456', fg: '#B0B7E8' },
    { bg: '#3A2E56', fg: '#C1B0E8' },
    { bg: '#4C2E56', fg: '#DAB0E8' },
    { bg: '#562E4E', fg: '#E8B0DD' },
    { bg: '#562E3D', fg: '#E8B0C5' },
  ],
};

/** mobile: `Space` (4 dp grid). Values in px. */
export const space = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  xxl: 24,
  xxxl: 32,
  huge: 40,
  giant: 48,
} as const;

/** mobile: `Radii`. Values in px. */
export const radii = { xs: 4, sm: 8, md: 12, lg: 16, xl: 20, full: 999 } as const;

/**
 * mobile: `IconSize` (16/20/24/32). `xs` (14) is the size mobile hard-codes in list rows
 * (attachment 13, pin 14, reply/forward 13) — consolidated into one token.
 */
export const iconSize = { xs: 14, sm: 16, md: 20, lg: 24, xl: 32 } as const;

/** mobile: `Motion`. Milliseconds. */
export const motion = {
  instant: 0,
  fast: 120,
  base: 200,
  slow: 300,
  page: 320,
  pageBack: 240,
  compose: 280,
  composeBack: 220,
} as const;

/** mobile: Curves.easeOutCubic / fastOutSlowIn / easeInOut as CSS cubic-beziers. */
export const easing = {
  standard: 'cubic-bezier(0.215, 0.61, 0.355, 1)',
  emphasized: 'cubic-bezier(0.4, 0, 0.2, 1)',
  symmetric: 'cubic-bezier(0.42, 0, 0.58, 1)',
} as const;

/** mobile: `Dimens`. Values in px. `touchTarget` applies in the touch (mobile-web) layout. */
export const dimens = {
  appBarHeight: 56,
  listRowMinHeight: 56,
  avatarSize: 32,
  fabSize: 56,
  touchTarget: 48,
  controlHeight: 48,
  dividerThickness: 1,
  selectionBarWidth: 3,
} as const;

/**
 * web: desktop density values. Mobile is touch-first (48 dp controls); a pointer-driven
 * desktop client uses compact controls. These are the only tokens with no mobile source.
 */
export const desktop = {
  controlHeight: 36,
  /** Single-line "wide" mail row (sender | subject — preview | meta). */
  rowHeightWide: 44,
  sidebarWidth: { laptop: 240, desktop: 256, wide: 272 },
  /** Icon-only sidebar used in the tablet layout. */
  sidebarRailWidth: 72,
  searchMaxWidth: 640,
  /** Drawer width in the mobile-web layout. */
  drawerWidth: 304,
  /** Sender column width in the wide mail-row layout. */
  rowSenderWidth: 200,
} as const;

/**
 * web: layout breakpoints (min-width, px). Mobile has none. Layout MODES are derived from
 * these in JS (`useShellMode`) — CSS never hard-codes a breakpoint literal.
 */
export const breakpoints = {
  mobile: 0,
  tablet: 768,
  laptop: 1024,
  desktop: 1280,
  wide: 1600,
} as const;
export type ShellMode = keyof typeof breakpoints;

/** web: mail list switches from stacked (mobile-like) to single-line rows at this list width. */
export const containers = { listWide: 640 } as const;

/**
 * mobile: dark theme uses no shadows (elevation = lighter surface + border);
 * light theme uses soft shadows (dialog elevation 8, snackbar 4). Values approximate the
 * Material elevation curve and are web adaptations of those elevations.
 */
export const shadows: Record<ThemeName, { menu: string; dialog: string }> = {
  light: {
    menu: '0 4px 12px #0000001F',
    dialog: '0 8px 24px #00000029',
  },
  dark: { menu: 'none', dialog: 'none' },
};

/** mobile: AppText.family. Web falls back to the OS UI font while Satoshi loads. */
export const fontFamily =
  "'Satoshi', system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif";

export const fontWeights = { regular: 400, medium: 500, semibold: 600, bold: 700 } as const;

export interface TypeRole {
  /** px on the web (rem in CSS at a 16 px root). */
  size: number;
  /** Line height in px. */
  line: number;
  weight: number;
  /** Letter-spacing in px. */
  tracking?: number;
  /** Mobile source size when the web value was adapted. */
  mobileSize?: number;
}

/**
 * mobile: AppText roles (scale 1.0). Sizes are mobile-exact except where `mobileSize` is set:
 * labelSmall (10.5) and overline (9.5) are raised to 11 / 10 px — the web legibility floor.
 * That is the only typographic deviation (flagged for confirmation).
 */
export const typography = {
  titleLarge: { size: 18, line: 24, weight: 700, tracking: -0.2 },
  titleMedium: { size: 15, line: 20, weight: 600 },
  bodyLarge: { size: 16, line: 24, weight: 400 },
  bodyMedium: { size: 13, line: 18, weight: 400 },
  listSenderRead: { size: 15, line: 19, weight: 500 },
  listSenderUnread: { size: 15, line: 19, weight: 700 },
  listSubjectRead: { size: 14, line: 18, weight: 500 },
  listSubjectUnread: { size: 14, line: 18, weight: 600 },
  listPreview: { size: 13, line: 18, weight: 400 },
  labelMedium: { size: 11, line: 15, weight: 600 },
  labelSmall: { size: 11, line: 14, weight: 600, mobileSize: 10.5 },
  overline: { size: 10, line: 13, weight: 700, tracking: 0.8, mobileSize: 9.5 },
} as const satisfies Record<string, TypeRole>;
export type TypeRoleName = keyof typeof typography;
