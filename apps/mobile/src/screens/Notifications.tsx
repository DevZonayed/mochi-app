import React, { useCallback, useState } from 'react';
import { View, Text, Pressable, ScrollView, RefreshControl } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import { useTheme } from '../theme';
import { Icon, type IconName } from '../Icon';
import { type AppEvent, type AppEventKind } from '../api';
import { getStr, setStr } from '../storage';
import { eventAllowed } from '../notifPrefs';
import { pullSync, pullSyncIfStale, useSyncStore } from '../syncStore';

const NOTIF_READ = 'maestro.mobile.notifReadTs';

type TintKey = 'blue' | 'purple' | 'orange' | 'teal' | 'green' | 'red' | 'indigo';
const KIND_META: Record<AppEventKind, { icon: IconName; tint: TintKey }> = {
  'job-done': { icon: 'checkCircle', tint: 'green' },
  'job-failed': { icon: 'xCircle', tint: 'red' },
  'job-cancelled': { icon: 'xCircle', tint: 'orange' },
  'approval-created': { icon: 'arrowRight', tint: 'orange' },
  'approval-resolved': { icon: 'checkCircle', tint: 'green' },
  'schedule-fired': { icon: 'clock', tint: 'blue' },
  'clone-done': { icon: 'checkCircle', tint: 'green' },
  'clone-failed': { icon: 'xCircle', tint: 'red' },
  research: { icon: 'shield', tint: 'indigo' },
  publish: { icon: 'send', tint: 'teal' },
  comm: { icon: 'send', tint: 'purple' },
  asset: { icon: 'clapper', tint: 'purple' },
};

function relTime(ts: number): string {
  const m = Math.floor((Date.now() - ts) / 60000);
  if (m < 1) return 'now';
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}
function dayLabel(ts: number): string {
  const d = new Date(ts); d.setHours(0, 0, 0, 0);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const diff = Math.round((today.getTime() - d.getTime()) / 86400000);
  if (diff <= 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

function useTints() {
  const { theme } = useTheme();
  return {
    blue: theme.color.blue,
    purple: theme.color.purple,
    orange: theme.color.orange,
    teal: theme.color.teal,
    green: theme.color.green,
    red: theme.color.red,
    indigo: theme.color.indigo,
  };
}

function InAppList({ events, readTs }: { events: AppEvent[]; readTs: number }) {
  const { theme } = useTheme();
  const tints = useTints();

  if (events.length === 0) {
    return (
      <View style={{ alignItems: 'center', paddingVertical: 60, paddingHorizontal: 30 }}>
        <View style={{ width: 64, height: 64, borderRadius: 20, backgroundColor: theme.color.fillSecondary, alignItems: 'center', justifyContent: 'center', marginBottom: 18 }}>
          <Icon name="checkCircle" size={32} color={theme.color.inkTertiary} />
        </View>
        <Text style={{ fontSize: 18, fontWeight: '700', color: theme.color.ink, marginBottom: 6 }}>Nothing yet</Text>
        <Text style={{ fontSize: 14, lineHeight: 20, color: theme.color.inkSecondary, textAlign: 'center' }}>Job results, approvals, schedules, and clones from your Mac show up here.</Text>
      </View>
    );
  }

  // group consecutive events by day label
  const sections: { day: string; rows: AppEvent[] }[] = [];
  for (const ev of events) {
    const day = dayLabel(ev.ts);
    const last = sections[sections.length - 1];
    if (last && last.day === day) last.rows.push(ev);
    else sections.push({ day, rows: [ev] });
  }

  return (
    <>
      {sections.map((section) => (
        <View key={section.day} style={{ marginBottom: 12 }}>
          <Text style={{ fontSize: 13, fontWeight: '600', letterSpacing: 0.4, textTransform: 'uppercase', color: theme.color.inkSecondary, paddingHorizontal: 20, paddingTop: 4, paddingBottom: 8 }}>
            {section.day}
          </Text>
          <View style={{ marginHorizontal: 16, backgroundColor: theme.color.bgElevated, borderRadius: 14, borderWidth: 0.5, borderColor: theme.color.separator, overflow: 'hidden' }}>
            {section.rows.map((ev, i) => {
              const meta = KIND_META[ev.kind] ?? { icon: 'shield' as IconName, tint: 'blue' as TintKey };
              const tint = tints[meta.tint];
              const unread = ev.ts > readTs;
              return (
                <View key={ev.id} style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 13, paddingHorizontal: 15, borderBottomWidth: i < section.rows.length - 1 ? 0.5 : 0, borderBottomColor: theme.color.separator }}>
                  <View style={{ width: 34, height: 34, borderRadius: 10, alignItems: 'center', justifyContent: 'center', backgroundColor: tint + '24' }}>
                    <Icon name={meta.icon} size={18} color={tint} />
                  </View>
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text style={{ fontSize: 15, lineHeight: 19, fontWeight: unread ? '600' : '500', color: theme.color.ink }}>{ev.title}</Text>
                    <Text style={{ fontSize: 12, color: theme.color.inkTertiary, marginTop: 3 }}>{ev.subtitle ? `${ev.subtitle} · ` : ''}{relTime(ev.ts)}</Text>
                  </View>
                  {unread ? <View style={{ width: 9, height: 9, borderRadius: 5, backgroundColor: theme.color.blue }} /> : null}
                </View>
              );
            })}
          </View>
        </View>
      ))}
    </>
  );
}

export function NotificationsScreen() {
  const { theme } = useTheme();
  const insets = useSafeAreaInsets();
  const nav = useNavigation<any>();
  // Events flow through the unified SyncStore; SSE 'replay' frames + live
  // events upsert them in real time. Sorted newest-first for the timeline.
  const allEvents = useSyncStore((s) => s.events);
  const syncing = useSyncStore((s) => s.syncing);
  const [readTs, setReadTs] = useState<number>(() => Number(getStr(NOTIF_READ)) || 0);

  // Skip the refetch if the cache is already fresh — the live WS already drips
  // new events in, so re-pulling on every tab focus only flashed the spinner.
  useFocusEffect(useCallback(() => { void pullSyncIfStale(); }, []));
  const onRefresh = useCallback(() => { void pullSync(); }, []);

  // Honor the Activity-feed category toggles from Settings.
  const visible = allEvents.filter((e) => eventAllowed(e.kind));

  const markAllRead = () => {
    const ts = visible[0]?.ts ?? Date.now();
    setReadTs(ts);
    setStr(NOTIF_READ, String(ts));
  };

  return (
    <View style={{ flex: 1, backgroundColor: theme.color.bg }}>
      <ScrollView
        contentContainerStyle={{ paddingTop: insets.top + 6, paddingBottom: 24 }}
        showsVerticalScrollIndicator={false}
        refreshControl={<RefreshControl refreshing={syncing} onRefresh={onRefresh} tintColor={theme.color.inkTertiary} />}
      >
        {/* back */}
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 16, paddingTop: 2, paddingBottom: 4 }}>
          <Pressable onPress={() => nav.goBack()} hitSlop={8}>
            <Icon name="arrowLeft" size={22} color={theme.color.blue} />
          </Pressable>
        </View>

        {/* large title */}
        <View style={{ paddingHorizontal: 20, paddingTop: 6, paddingBottom: 16, flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between' }}>
          <Text style={{ fontSize: 34, fontWeight: '700', letterSpacing: -0.7, color: theme.color.ink }}>Activity</Text>
          <Pressable onPress={markAllRead} hitSlop={8}>
            <Text style={{ fontSize: 15, fontWeight: '500', color: theme.color.blue }}>Mark all read</Text>
          </Pressable>
        </View>

        <InAppList events={visible} readTs={readTs} />
      </ScrollView>
    </View>
  );
}
