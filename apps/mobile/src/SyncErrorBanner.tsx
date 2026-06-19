/* Actionable banner shown when the last sync failed, so the phone never sits on
   an endless spinner when it's on a stale or disconnected deck. Driven by the
   sync store's `syncError`:

   - unauthorized → the relay rejected our pairing token (kicked / code rotated /
     our deck was evicted). Offer RE-PAIR (drops to the enter-code screen).
   - offline      → relay reachable but no live Mac for our token. Offer RETRY.
   - network      → couldn't reach the relay at all. Offer RETRY. */

import React from 'react';
import { View, Text, Pressable } from 'react-native';
import { useTheme } from './theme';
import { Icon } from './Icon';
import { gotoRepair } from './navRef';
import type { SyncErrorKind } from './syncErrors';

const COPY: Record<SyncErrorKind, { msg: string; cta: string; repair: boolean }> = {
  unauthorized: { msg: 'This device was disconnected. Re-pair with the code in the Mac’s Settings → Devices.', cta: 'Re-pair', repair: true },
  offline: { msg: 'Your Mac looks offline — open the Maestro desktop app, then retry.', cta: 'Retry', repair: false },
  network: { msg: 'Can’t reach the relay. Check your connection, then retry.', cta: 'Retry', repair: false },
};

export function SyncErrorBanner({ kind, onRetry }: { kind: SyncErrorKind; onRetry: () => void }) {
  const { theme } = useTheme();
  const c = COPY[kind];
  return (
    <View
      style={{
        marginHorizontal: 16, marginBottom: 12, padding: 12, borderRadius: 12,
        backgroundColor: theme.color.orange + '14', borderWidth: 0.5, borderColor: theme.color.orange + '40',
        flexDirection: 'row', alignItems: 'center', gap: 8,
      }}
    >
      <Icon name="x" size={14} color={theme.color.orange} stroke={2.4} />
      <Text style={{ flex: 1, fontSize: 13, color: theme.color.ink }}>{c.msg}</Text>
      <Pressable
        onPress={() => (c.repair ? gotoRepair() : onRetry())}
        hitSlop={8}
        style={{ paddingHorizontal: 12, paddingVertical: 6, borderRadius: 9, backgroundColor: theme.color.orange }}
      >
        <Text style={{ fontSize: 13, fontWeight: '600', color: '#fff' }}>{c.cta}</Text>
      </Pressable>
    </View>
  );
}
