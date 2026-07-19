/**
 * SecureControllerBlocked — F2 defense-in-depth notice. Rendered in place of a legacy
 * direct-server screen if one is ever reached while secure-controller mode is active
 * (the ROOT navigator normally unmounts the entire legacy tree in active mode, so this
 * is belt-and-suspenders). It performs NO fetch/mutation and offers no route back into
 * the legacy app — the secure controller shell is the only surface in active mode.
 */
import React from 'react';
import { View, Text } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../theme';
import { Icon } from '../Icon';

export function SecureControllerBlocked() {
  const { theme } = useTheme();
  const insets = useSafeAreaInsets();
  return (
    <View style={{ flex: 1, backgroundColor: theme.color.bg, alignItems: 'center', justifyContent: 'center', paddingTop: insets.top, paddingHorizontal: 32 }}>
      <View style={{ width: 64, height: 64, borderRadius: 20, backgroundColor: theme.color.green + '1c', alignItems: 'center', justifyContent: 'center', marginBottom: 16 }}>
        <Icon name="shield" size={28} color={theme.color.green} />
      </View>
      <Text accessibilityRole="header" style={{ fontSize: 18, fontWeight: '700', color: theme.color.ink, textAlign: 'center', marginBottom: 6 }}>Secure controller</Text>
      <Text style={{ fontSize: 14, lineHeight: 20, color: theme.color.inkSecondary, textAlign: 'center' }}>
        This device is in secure controller mode. The read-only mirror is the only surface here.
      </Text>
    </View>
  );
}
