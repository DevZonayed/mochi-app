import React from 'react';
import { View, Text } from 'react-native';
import { useTheme } from './theme';
import { useConnPath } from './useLive';

/* Tiny header indicator. It appears ONLY when the phone has a live direct (P2P)
   channel to the Mac — the notable state. On the normal relay path it renders
   nothing, so it never adds noise for users who haven't enabled P2P. */
export function ConnPill() {
  const { theme } = useTheme();
  const path = useConnPath();
  if (path !== 'p2p') return null;
  return (
    <View
      style={{
        alignSelf: 'flex-start',
        marginTop: 8,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 5,
        height: 22,
        paddingHorizontal: 9,
        borderRadius: 11,
        backgroundColor: theme.color.green,
      }}
    >
      <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: '#fff' }} />
      <Text style={{ fontSize: 11, fontWeight: '700', color: '#fff' }}>Direct</Text>
    </View>
  );
}
