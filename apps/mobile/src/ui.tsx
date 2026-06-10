import React from 'react';
import { View, Text, Pressable, StyleSheet, Platform, type ViewStyle, type TextStyle } from 'react-native';
import { useTheme } from './theme';
import { Icon, type IconName } from './Icon';

export function cardShadow(): ViewStyle {
  return (Platform.select({
    ios: { shadowColor: '#0f1432', shadowOpacity: 0.1, shadowRadius: 18, shadowOffset: { width: 0, height: 8 } },
    android: { elevation: 3 },
    default: {},
  }) ?? {}) as ViewStyle;
}

export function Card({ children, style }: { children: React.ReactNode; style?: ViewStyle }) {
  const { theme } = useTheme();
  return (
    <View
      style={[
        { backgroundColor: theme.color.bgElevated, borderRadius: 16, borderWidth: StyleSheet.hairlineWidth, borderColor: theme.color.separator },
        cardShadow(),
        style,
      ]}
    >
      {children}
    </View>
  );
}

export function SectionLabel({ children, icon, color }: { children: React.ReactNode; icon?: IconName; color?: string }) {
  const { theme } = useTheme();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 11 }}>
      {icon ? <Icon name={icon} size={15} color={color ?? theme.color.inkSecondary} /> : null}
      <Text style={{ fontSize: 13, fontWeight: '700', letterSpacing: 0.4, textTransform: 'uppercase', color: theme.color.inkSecondary }}>
        {children}
      </Text>
    </View>
  );
}

export function ProjectDot({ color, size = 8 }: { color: string; size?: number }) {
  return <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: color }} />;
}

export function ProgressBar({ pct, color }: { pct: number; color?: string }) {
  const { theme } = useTheme();
  return (
    <View style={{ flex: 1, height: 3, borderRadius: 2, backgroundColor: theme.color.fillSecondary, overflow: 'hidden' }}>
      <View style={{ width: `${pct}%`, height: '100%', backgroundColor: color ?? theme.color.blue }} />
    </View>
  );
}

export function Mono({ children, style }: { children: React.ReactNode; style?: TextStyle }) {
  const { theme } = useTheme();
  return <Text style={[{ fontFamily: theme.fontFamily.mono, color: theme.color.ink }, style]}>{children}</Text>;
}

type PillKind = 'primary' | 'plain' | 'green';
export function Pill({
  children,
  onPress,
  kind = 'primary',
  icon,
  style,
  disabled,
}: {
  children: React.ReactNode;
  onPress?: () => void;
  kind?: PillKind;
  icon?: IconName;
  style?: ViewStyle;
  disabled?: boolean;
}) {
  const { theme } = useTheme();
  const kinds: Record<PillKind, { bg: string; fg: string }> = {
    primary: { bg: disabled ? theme.color.fillSecondary : theme.color.blue, fg: disabled ? theme.color.inkTertiary : '#fff' },
    plain: { bg: theme.color.fillSecondary, fg: theme.color.ink },
    green: { bg: theme.color.green, fg: '#fff' },
  };
  const k = kinds[kind];
  return (
    <Pressable
      onPress={disabled ? undefined : onPress}
      style={({ pressed }) => [
        {
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 7,
          height: 50,
          paddingHorizontal: 22,
          borderRadius: theme.radius.pill,
          backgroundColor: k.bg,
          transform: [{ scale: pressed ? 0.97 : 1 }],
        },
        style,
      ]}
    >
      {icon ? <Icon name={icon} size={18} color={k.fg} /> : null}
      <Text style={{ fontSize: 17, fontWeight: '600', color: k.fg }}>{children}</Text>
    </Pressable>
  );
}

export function Group({ children, header, footer }: { children: React.ReactNode; header?: string; footer?: string }) {
  const { theme } = useTheme();
  return (
    <View style={{ paddingHorizontal: 16 }}>
      {header ? (
        <Text style={{ fontSize: 13, color: theme.color.inkSecondary, paddingHorizontal: 14, paddingBottom: 7, textTransform: 'uppercase', letterSpacing: 0.4 }}>
          {header}
        </Text>
      ) : null}
      <View style={{ backgroundColor: theme.color.bgElevated, borderRadius: 12, overflow: 'hidden', borderWidth: StyleSheet.hairlineWidth, borderColor: theme.color.separator }}>
        {children}
      </View>
      {footer ? <Text style={{ fontSize: 13, color: theme.color.inkSecondary, paddingHorizontal: 14, paddingTop: 7 }}>{footer}</Text> : null}
    </View>
  );
}

export function Row({ children, onPress, last, style }: { children: React.ReactNode; onPress?: () => void; last?: boolean; style?: ViewStyle }) {
  const { theme } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        minHeight: 48,
        paddingHorizontal: 16,
        paddingVertical: 10,
        borderBottomWidth: last ? 0 : StyleSheet.hairlineWidth,
        borderBottomColor: theme.color.separator,
        ...style,
      }}
    >
      {children}
    </Pressable>
  );
}

/** Project palette mirror (M_PROJ from the mobile design). */
export function useProjects() {
  const { theme } = useTheme();
  return {
    atlas: { name: 'Atlas API', color: theme.color.blue },
    content: { name: 'Q3 Content', color: theme.color.purple },
    scan: { name: 'Market Scan', color: theme.color.indigo },
    brand: { name: 'Brand Refresh', color: theme.color.teal },
    infra: { name: 'Infra / CI', color: theme.color.orange },
  } as const;
}
