import React from 'react';
import { View, Text, Pressable, ScrollView } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import { useTheme } from '../theme';
import { Icon, type IconName } from '../Icon';
import { cardShadow } from '../ui';
import { api, type OutboxEntry, type OutboxState } from '../api';

/** Relative "x min ago" label. */
function ago(ts: number): string {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} hr ago`;
  return `${Math.round(h / 24)} d ago`;
}

const STATE_META: Record<OutboxState, { icon: IconName; label: string }> = {
  applied: { icon: 'checkCircle', label: 'Applied' },
  rejected: { icon: 'xCircle', label: 'Rejected' },
  conflict: { icon: 'refresh', label: 'Mac offline' },
};

export function OutboxScreen() {
  const { theme } = useTheme();
  const insets = useSafeAreaInsets();
  const nav = useNavigation<any>();

  const [entries, setEntries] = React.useState<OutboxEntry[]>(() => api.outbox());
  React.useEffect(() => {
    const refresh = () => setEntries(api.outbox());
    refresh();
    return api.onOutbox(refresh);
  }, []);

  const tintFor = (s: OutboxState): string =>
    s === 'applied' ? theme.color.green : s === 'rejected' ? theme.color.red : theme.color.orange;

  return (
    <View style={{ flex: 1, backgroundColor: theme.color.bg }}>
      <ScrollView contentContainerStyle={{ paddingBottom: 24 }} showsVerticalScrollIndicator={false}>
        {/* back button row */}
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 16, paddingTop: insets.top + 6, paddingBottom: 2 }}>
          <Pressable onPress={() => nav.navigate('Tabs', { screen: 'Settings' })} hitSlop={8}>
            <Icon name="arrowLeft" size={22} color={theme.color.blue} />
          </Pressable>
        </View>

        {/* large title */}
        <View style={{ paddingHorizontal: 20, paddingTop: 6, paddingBottom: 10 }}>
          <Text style={{ fontSize: 34, fontWeight: '700', letterSpacing: -0.7, color: theme.color.ink }}>Outbox</Text>
        </View>

        {entries.length === 0 ? (
          <View style={{ alignItems: 'center', justifyContent: 'center', paddingTop: 80, paddingHorizontal: 40, gap: 12 }}>
            <Icon name="send" size={34} color={theme.color.inkTertiary} />
            <Text style={{ fontSize: 16, fontWeight: '600', color: theme.color.ink, textAlign: 'center' }}>No intents yet</Text>
            <Text style={{ fontSize: 13, lineHeight: 19, color: theme.color.inkTertiary, textAlign: 'center' }}>
              Actions you take here — start a job, approve a gate — run on your Mac and show up in this log.
            </Text>
          </View>
        ) : (
          <View style={{ paddingHorizontal: 16, paddingTop: 6, gap: 12 }}>
            {entries.map((it) => {
              const tint = tintFor(it.state);
              const meta = STATE_META[it.state];
              const ok = it.state === 'applied';
              const bg = ok ? 'rgba(52,199,89,0.07)' : it.state === 'rejected' ? 'rgba(255,59,48,0.06)' : 'rgba(255,149,0,0.07)';
              const border = ok ? 'rgba(52,199,89,0.3)' : it.state === 'rejected' ? 'rgba(255,59,48,0.3)' : 'rgba(255,149,0,0.4)';

              return (
                <View
                  key={it.id}
                  style={[
                    { padding: 15, borderRadius: 16, overflow: 'hidden', backgroundColor: bg, borderWidth: 1, borderColor: border },
                    cardShadow(),
                  ]}
                >
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
                    <View style={{ width: 38, height: 38, borderRadius: 11, alignItems: 'center', justifyContent: 'center', backgroundColor: tint + '24' }}>
                      <Icon name={meta.icon} size={19} color={tint} />
                    </View>
                    <View style={{ flex: 1, minWidth: 0 }}>
                      <Text style={{ fontSize: 16, fontWeight: '600', color: theme.color.ink }}>{it.desc}</Text>
                      <Text style={{ fontSize: 13, color: theme.color.inkTertiary, marginTop: 3 }}>{ago(it.ts)}</Text>
                    </View>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5, height: 24, paddingHorizontal: 10, borderRadius: 12, backgroundColor: tint + '24' }}>
                      <Text style={{ fontSize: 12, fontWeight: '600', color: tint }}>{meta.label}</Text>
                    </View>
                  </View>

                  {!ok && it.why ? (
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 11, paddingTop: 11, borderTopWidth: 0.5, borderTopColor: theme.color.separator }}>
                      <Icon name={it.state === 'rejected' ? 'xCircle' : 'refresh'} size={14} color={tint} />
                      <Text style={{ flex: 1, fontSize: 13, lineHeight: 18, color: it.state === 'rejected' ? theme.color.red : theme.color.inkSecondary }}>{it.why}</Text>
                    </View>
                  ) : null}
                </View>
              );
            })}

            <Text style={{ fontSize: 13, lineHeight: 19, color: theme.color.inkTertiary, textAlign: 'center', paddingTop: 8, paddingHorizontal: 20 }}>
              Every action runs on your Mac the moment you take it. This is the log of what this phone dispatched and how the Mac answered.
            </Text>
          </View>
        )}
      </ScrollView>
    </View>
  );
}
