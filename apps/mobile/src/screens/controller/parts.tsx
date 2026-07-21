/**
 * Shared presentational parts for the Phase 3C2 read-only controller UI. Reuses the
 * app's existing visual language (theme tokens, Card/Row/Group, Icon, safe-area) so
 * the controller shadow pages match the rest of Mochlet exactly. No emoji, gradients,
 * glassmorphism, or new brand — decorative tints only, never a security signal.
 */
import React from 'react';
import { View, Text, Pressable, ActivityIndicator, type ViewStyle } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../../theme';
import { Icon, type IconName } from '../../Icon';

/** Full-screen background wrapper honoring the safe area. */
export function Screen({ children }: { children: React.ReactNode }) {
  const { theme } = useTheme();
  return <View style={{ flex: 1, backgroundColor: theme.color.bg }}>{children}</View>;
}

/** A large screen title + optional subtitle, matching the Projects/Home headers.
 * `subtitleColor` overrides the subtitle color for callers that need a higher-contrast
 * standing note (e.g. the Screen viewer's safety copy — M-B); defaults to the muted token. */
export function ScreenHeader({ title, subtitle, right, subtitleColor }: { title: string; subtitle?: string; right?: React.ReactNode; subtitleColor?: string }) {
  const { theme } = useTheme();
  return (
    <View style={{ paddingHorizontal: 20, paddingBottom: 12, flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between', gap: 12 }}>
      <View style={{ flex: 1 }}>
        <Text accessibilityRole="header" style={{ fontSize: 32, fontWeight: '700', letterSpacing: -0.6, color: theme.color.ink }}>{title}</Text>
        {subtitle ? <Text style={{ fontSize: 14, color: subtitleColor ?? theme.color.inkSecondary, marginTop: 3 }}>{subtitle}</Text> : null}
      </View>
      {right ?? null}
    </View>
  );
}

/** Neutral empty state row (never a fabricated placeholder). */
export function EmptyState({ icon, title, body }: { icon: IconName; title: string; body?: string }) {
  const { theme } = useTheme();
  return (
    <View style={{ alignItems: 'center', paddingVertical: 48, paddingHorizontal: 28 }}>
      <View style={{ width: 64, height: 64, borderRadius: 20, backgroundColor: theme.color.blue + '18', alignItems: 'center', justifyContent: 'center', marginBottom: 16 }}>
        <Icon name={icon} size={28} color={theme.color.blue} />
      </View>
      <Text style={{ fontSize: 18, fontWeight: '700', color: theme.color.ink, marginBottom: 6, textAlign: 'center' }}>{title}</Text>
      {body ? <Text style={{ fontSize: 14, lineHeight: 20, color: theme.color.inkSecondary, textAlign: 'center' }}>{body}</Text> : null}
    </View>
  );
}

/** A centered spinner card for transitional phases. */
export function Busy({ label }: { label: string }) {
  const { theme } = useTheme();
  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32 }} accessibilityRole="progressbar" accessibilityLabel={label}>
      <ActivityIndicator size="large" color={theme.color.blue} />
      <Text style={{ fontSize: 15, color: theme.color.inkSecondary, marginTop: 16, textAlign: 'center' }}>{label}</Text>
    </View>
  );
}

export type StatusTone = 'online' | 'offline' | 'locked' | 'pending' | 'neutral';
/** Small status chip mirroring the desktop status dot + label. */
export function StatusChip({ tone, label }: { tone: StatusTone; label: string }) {
  const { theme } = useTheme();
  // The DOT + background stay tone-colored (semantic), but the LABEL text uses the primary
  // `ink` token so it always clears WCAG AA — the tone colors (esp. neutral inkTertiary and
  // orange) were far below 4.5:1 as small chip text (M-B). Contrast is verified in
  // shadowScreenContrast.test.ts against the 12%-tint chip background on light + dark.
  const color = tone === 'online' ? theme.color.green : tone === 'locked' ? theme.color.red : tone === 'pending' ? theme.color.orange : theme.color.inkTertiary;
  return (
    <View accessibilityRole="text" accessibilityLabel={label} style={{ flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 9, height: 22, borderRadius: 11, backgroundColor: color + '20' }}>
      <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: color }} />
      <Text style={{ fontSize: 12, fontWeight: '600', color: theme.color.ink }}>{label}</Text>
    </View>
  );
}

/** A 44×44-minimum tappable list row (accessible target size). */
export function TapRow({ children, onPress, label, last, style }: { children: React.ReactNode; onPress?: () => void; label?: string; last?: boolean; style?: ViewStyle }) {
  const { theme } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole={onPress ? 'button' : undefined}
      accessibilityLabel={label}
      style={({ pressed }) => ({
        flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 48, paddingHorizontal: 16, paddingVertical: 11,
        borderBottomWidth: last ? 0 : 0.5, borderBottomColor: theme.color.separator,
        opacity: pressed && onPress ? 0.6 : 1, ...style,
      })}
    >
      {children}
    </Pressable>
  );
}

/** A primary pill button (44px min height, accessible). */
export function PrimaryButton({ title, icon, onPress, disabled, label }: { title: string; icon?: IconName; onPress: () => void; disabled?: boolean; label?: string }) {
  const { theme } = useTheme();
  return (
    <Pressable
      onPress={disabled ? undefined : onPress}
      accessibilityRole="button"
      accessibilityState={{ disabled: !!disabled }}
      accessibilityLabel={label ?? title}
      style={({ pressed }) => ({
        flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, minHeight: 50, paddingHorizontal: 22,
        borderRadius: theme.radius.pill, backgroundColor: disabled ? theme.color.fillSecondary : theme.color.blue,
        transform: [{ scale: pressed && !disabled ? 0.98 : 1 }],
      })}
    >
      {icon ? <Icon name={icon} size={18} color={disabled ? theme.color.inkTertiary : '#fff'} /> : null}
      <Text style={{ fontSize: 16, fontWeight: '600', color: disabled ? theme.color.inkTertiary : '#fff' }}>{title}</Text>
    </Pressable>
  );
}

/** A ghost/secondary pill button. */
export function GhostButton({ title, onPress, tone }: { title: string; onPress: () => void; tone?: 'default' | 'danger' }) {
  const { theme } = useTheme();
  const fg = tone === 'danger' ? theme.color.red : theme.color.ink;
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={title}
      style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', minHeight: 44, paddingHorizontal: 18, borderRadius: theme.radius.pill, backgroundColor: theme.color.fillSecondary, opacity: pressed ? 0.7 : 1 })}>
      <Text style={{ fontSize: 15, fontWeight: '600', color: fg }}>{title}</Text>
    </Pressable>
  );
}

/** Decorative id tint (color only — never authority). Mirrors the desktop deviceTint. */
export function idTint(id: string, theme: ReturnType<typeof useTheme>['theme']): string {
  let h = 0; for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  const tints = [theme.color.blue, theme.color.purple, theme.color.teal, theme.color.indigo, theme.color.orange];
  return tints[h % tints.length];
}

export function useInsets() { return useSafeAreaInsets(); }

// ── project type helpers ────────────────────────────────────────────────────
export type ProjectKind = 'code' | 'design' | 'content' | 'research' | 'general';
const KIND_META: Record<ProjectKind, { icon: IconName; label: string }> = {
  code: { icon: 'terminal', label: 'Code' },
  design: { icon: 'palette', label: 'Design' },
  content: { icon: 'file', label: 'Content' },
  research: { icon: 'telescope', label: 'Research' },
  general: { icon: 'folder', label: 'General' },
};
export function kindMeta(kind: string | undefined): { icon: IconName; label: string } {
  return KIND_META[(kind ?? 'general') as ProjectKind] ?? KIND_META.general;
}
export function kindColor(kind: string | undefined, theme: ReturnType<typeof useTheme>['theme']): string {
  switch (kind) {
    case 'code': return theme.color.blue;
    case 'design': return theme.color.purple;
    case 'content': return theme.color.orange;
    case 'research': return theme.color.teal;
    default: return theme.color.indigo;
  }
}

/** Small colored type badge for project kind. */
export function KindBadge({ kind, size = 36 }: { kind: string | undefined; size?: number }) {
  const { theme } = useTheme();
  const color = kindColor(kind, theme);
  const meta = kindMeta(kind);
  return (
    <View style={{ width: size, height: size, borderRadius: size * 0.3, backgroundColor: color + '20', alignItems: 'center', justifyContent: 'center' }}>
      <Icon name={meta.icon} size={size * 0.48} color={color} />
    </View>
  );
}

// ── WhatsApp-style delivery indicators ──────────────────────────────────────
export type DeliveryPhase = 'sending' | 'sent' | 'delivered' | 'read' | 'failed';
export function DeliveryIndicator({ phase }: { phase: DeliveryPhase }) {
  const { theme } = useTheme();
  if (phase === 'sending') return <Icon name="clock" size={13} color={theme.color.inkTertiary} />;
  if (phase === 'failed') return <Icon name="alert" size={13} color={theme.color.red} />;
  const checkColor = phase === 'read' ? theme.color.blue : theme.color.inkTertiary;
  if (phase === 'sent') return <Icon name="check" size={13} color={checkColor} />;
  return <Icon name="checkCheck" size={13} color={checkColor} />;
}

/** A WhatsApp-style message bubble. */
export function MessageBubble({ text, time, delivery, fromMe }: { text: string; time?: string; delivery?: DeliveryPhase; fromMe: boolean }) {
  const { theme } = useTheme();
  return (
    <View style={{ alignSelf: fromMe ? 'flex-end' : 'flex-start', maxWidth: '82%', marginVertical: 3 }}>
      <View style={{
        backgroundColor: fromMe ? theme.color.blue : theme.color.bgElevated,
        borderRadius: 18, borderBottomRightRadius: fromMe ? 4 : 18, borderBottomLeftRadius: fromMe ? 18 : 4,
        paddingHorizontal: 14, paddingTop: 10, paddingBottom: 8,
        borderWidth: fromMe ? 0 : 0.5, borderColor: theme.color.separator,
      }}>
        <Text style={{ fontSize: 15, lineHeight: 21, color: fromMe ? '#fff' : theme.color.ink }}>{text}</Text>
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', gap: 4, marginTop: 4 }}>
          {time ? <Text style={{ fontSize: 11, color: fromMe ? 'rgba(255,255,255,0.7)' : theme.color.inkTertiary }}>{time}</Text> : null}
          {delivery && fromMe ? <DeliveryIndicator phase={delivery} /> : null}
        </View>
      </View>
    </View>
  );
}

/** A floating pill-style connection badge. */
export function ConnBadge({ online }: { online: boolean }) {
  const { theme } = useTheme();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 12, height: 28, borderRadius: 14, backgroundColor: (online ? theme.color.green : theme.color.orange) + '18', borderWidth: 0.5, borderColor: (online ? theme.color.green : theme.color.orange) + '40' }}>
      <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: online ? theme.color.green : theme.color.orange }} />
      <Text style={{ fontSize: 12.5, fontWeight: '600', color: theme.color.ink }}>{online ? 'Live' : 'Offline'}</Text>
    </View>
  );
}
