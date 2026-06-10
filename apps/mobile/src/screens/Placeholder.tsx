import React from 'react';
import { View, Text } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../theme';
import { Icon, type IconName } from '../Icon';

/** Intentional placeholder for screens whose pixel-perfect design is ready
 *  in the handoff bundle but whose native RN port is still in progress. */
export function Placeholder({ title, subtitle, icon = 'spark', file }: { title: string; subtitle?: string; icon?: IconName; file?: string }) {
  const { theme } = useTheme();
  const insets = useSafeAreaInsets();
  return (
    <View style={{ flex: 1, backgroundColor: theme.color.bg, paddingTop: insets.top }}>
      <View style={{ paddingHorizontal: 20, paddingTop: 6, paddingBottom: 10 }}>
        <Text style={{ fontSize: 34, fontWeight: '700', letterSpacing: -0.7, color: theme.color.ink }}>{title}</Text>
        {subtitle ? <Text style={{ marginTop: 6, fontSize: 15, color: theme.color.inkSecondary }}>{subtitle}</Text> : null}
      </View>
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: 14, padding: 24 }}>
        <View style={{ width: 66, height: 66, borderRadius: 20, alignItems: 'center', justifyContent: 'center', backgroundColor: theme.color.fillSecondary }}>
          <Icon name={icon} size={28} color={theme.color.inkSecondary} />
        </View>
        <Text style={{ fontSize: 17, fontWeight: '600', color: theme.color.ink }}>Designed ✓ — porting to native</Text>
        <Text style={{ textAlign: 'center', fontSize: 14, lineHeight: 20, color: theme.color.inkSecondary, maxWidth: 290 }}>
          The pixel-perfect spec for this screen is in the handoff bundle. The React Native port is in progress.
        </Text>
        {file ? <Text style={{ fontFamily: theme.fontFamily.mono, fontSize: 12, color: theme.color.inkTertiary }}>{file}</Text> : null}
      </View>
    </View>
  );
}
