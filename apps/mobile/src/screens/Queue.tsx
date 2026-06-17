import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, Pressable, ScrollView, Animated, StyleSheet } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import { useTheme } from '../theme';
import { Icon } from '../Icon';
import { api, type Schedule, type Project } from '../api';
import { useLive } from '../useLive';

function MSwitch({ value, onValueChange }: { value: boolean; onValueChange: (v: boolean) => void }) {
  const { theme } = useTheme();
  const a = React.useRef(new Animated.Value(value ? 1 : 0)).current;
  React.useEffect(() => { Animated.timing(a, { toValue: value ? 1 : 0, duration: 200, useNativeDriver: false }).start(); }, [a, value]);
  const bg = a.interpolate({ inputRange: [0, 1], outputRange: [theme.color.fillSecondary, theme.color.green] });
  const left = a.interpolate({ inputRange: [0, 1], outputRange: [2, 22] });
  return (
    <Pressable onPress={() => onValueChange(!value)} hitSlop={6}>
      <Animated.View style={{ width: 51, height: 31, borderRadius: 16, backgroundColor: bg, justifyContent: 'center' }}>
        <Animated.View style={{ position: 'absolute', top: 2, left, width: 27, height: 27, borderRadius: 14, backgroundColor: '#fff' }} />
      </Animated.View>
    </Pressable>
  );
}

/** "in 2h 5m" / "in 3m" / "due" countdown to an absolute time. */
function until(ts: number, nowMs: number): string {
  const s = Math.round((ts - nowMs) / 1000);
  if (s <= 0) return 'due now';
  const m = Math.round(s / 60);
  if (m < 60) return `in ${m}m`;
  const h = Math.floor(m / 60);
  return `in ${h}h ${m % 60}m`;
}

export function QueueScreen() {
  const { theme } = useTheme();
  const insets = useSafeAreaInsets();
  const nav = useNavigation<any>();

  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [projects, setProjects] = useState<Record<string, Project>>({});
  const [now, setNow] = useState(Date.now());

  const load = useCallback(() => {
    api.listSchedules().then(setSchedules).catch(() => {});
    api.listProjects().then((ps) => setProjects(Object.fromEntries(ps.map((p) => [p.id, p])))).catch(() => {});
  }, []);

  useFocusEffect(useCallback(() => { load(); }, [load]));
  useLive(['schedule'], load);
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);

  // Queued messages (one-shot fireAt) first, then recurring schedules.
  const queued = schedules.filter((s) => s.fireAt).sort((a, b) => (a.fireAt ?? 0) - (b.fireAt ?? 0));
  const recurring = schedules.filter((s) => !s.fireAt);

  const cancel = (id: string) => { setSchedules((s) => s.filter((x) => x.id !== id)); void api.deleteSchedule(id).catch(() => {}).finally(load); };
  const toggle = (id: string, enabled: boolean) => { void api.toggleSchedule(id, enabled).catch(() => {}).finally(load); };

  const Section = ({ title, items, oneShot }: { title: string; items: Schedule[]; oneShot: boolean }) => (
    items.length === 0 ? null : (
      <View style={{ marginBottom: 18 }}>
        <Text style={{ fontSize: 13, fontWeight: '700', letterSpacing: 0.4, textTransform: 'uppercase', color: theme.color.inkSecondary, paddingHorizontal: 20, paddingBottom: 8 }}>{title}</Text>
        <View style={{ marginHorizontal: 16, backgroundColor: theme.color.bgElevated, borderRadius: 14, borderWidth: StyleSheet.hairlineWidth, borderColor: theme.color.separator, overflow: 'hidden' }}>
          {items.map((s, i) => {
            const proj = s.projectId ? projects[s.projectId] : undefined;
            return (
              <View key={s.id} style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 13, paddingHorizontal: 15, borderBottomWidth: i < items.length - 1 ? StyleSheet.hairlineWidth : 0, borderBottomColor: theme.color.separator }}>
                <View style={{ width: 32, height: 32, borderRadius: 9, alignItems: 'center', justifyContent: 'center', backgroundColor: theme.color.blue + '1c' }}>
                  <Icon name={oneShot ? 'send' : 'clock'} size={16} color={theme.color.blue} />
                </View>
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text numberOfLines={1} style={{ fontSize: 15, fontWeight: '600', color: theme.color.ink }}>{s.prompt || s.title}</Text>
                  <Text numberOfLines={1} style={{ fontSize: 12, color: theme.color.inkTertiary, marginTop: 2 }}>
                    {proj ? `${proj.name} · ` : ''}{oneShot && s.fireAt ? until(s.fireAt, now) : `${s.cadence} · ${s.time || ''}`}
                  </Text>
                </View>
                {oneShot ? (
                  <Pressable onPress={() => cancel(s.id)} hitSlop={8} style={{ width: 30, height: 30, borderRadius: 15, alignItems: 'center', justifyContent: 'center', backgroundColor: theme.color.fillSecondary }}>
                    <Icon name="x" size={15} color={theme.color.red} />
                  </Pressable>
                ) : (
                  <MSwitch value={s.enabled} onValueChange={(v) => toggle(s.id, v)} />
                )}
              </View>
            );
          })}
        </View>
      </View>
    )
  );

  return (
    <View style={{ flex: 1, backgroundColor: theme.color.bg }}>
      <ScrollView contentContainerStyle={{ paddingTop: insets.top + 4, paddingBottom: 30 }} showsVerticalScrollIndicator={false}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 16, paddingBottom: 2 }}>
          <Pressable onPress={() => nav.goBack()} hitSlop={8}><Icon name="arrowLeft" size={22} color={theme.color.blue} /></Pressable>
        </View>
        <View style={{ paddingHorizontal: 20, paddingTop: 6, paddingBottom: 14 }}>
          <Text style={{ fontSize: 34, fontWeight: '700', letterSpacing: -0.7, color: theme.color.ink }}>Queue</Text>
          <Text style={{ fontSize: 14, color: theme.color.inkSecondary, marginTop: 3 }}>Messages and schedules waiting to run on your Mac.</Text>
        </View>

        {queued.length === 0 && recurring.length === 0 ? (
          <View style={{ alignItems: 'center', paddingVertical: 70, paddingHorizontal: 36 }}>
            <View style={{ width: 64, height: 64, borderRadius: 20, backgroundColor: theme.color.fillSecondary, alignItems: 'center', justifyContent: 'center', marginBottom: 16 }}>
              <Icon name="clock" size={30} color={theme.color.inkTertiary} />
            </View>
            <Text style={{ fontSize: 16, fontWeight: '600', color: theme.color.ink, marginBottom: 6 }}>Nothing queued</Text>
            <Text style={{ fontSize: 14, lineHeight: 20, color: theme.color.inkSecondary, textAlign: 'center' }}>Schedule a message from a chat (the clock button) and it appears here with a live countdown.</Text>
          </View>
        ) : (
          <>
            <Section title="Queued messages" items={queued} oneShot />
            <Section title="Recurring" items={recurring} oneShot={false} />
          </>
        )}
      </ScrollView>
    </View>
  );
}
