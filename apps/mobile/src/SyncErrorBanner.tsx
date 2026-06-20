/* Actionable banner shown when the last sync failed, so the phone never sits on
   an endless spinner when the session or the active host is unavailable. Driven by
   the sync store's `syncError`:

   - unauthorized → the server rejected our session (expired / signed out
     elsewhere). Offer SIGN IN (drops to the Login screen).
   - offline      → server reachable but the active Mac is offline (or none is
     selected yet). Offer RETRY.
   - network      → couldn't reach the server at all. Offer RETRY. */

import React from 'react';
import { View, Text, Pressable } from 'react-native';
import { useTheme } from './theme';
import { Icon } from './Icon';
import { gotoRepair } from './navRef';
import type { SyncErrorKind } from './syncErrors';

const COPY: Record<SyncErrorKind, { msg: string; cta: string; repair: boolean }> = {
  unauthorized: { msg: 'Your session expired. Sign in again to reconnect.', cta: 'Sign in', repair: true },
  offline: { msg: 'Your Mac looks offline — open the Maestro desktop app, then retry.', cta: 'Retry', repair: false },
  network: { msg: 'Can’t reach the server. Check your connection, then retry.', cta: 'Retry', repair: false },
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
