import React, { useEffect, useRef, useState } from 'react';
import { View, Text, Pressable, ScrollView, Animated } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import { useTheme } from '../theme';
import { Icon, type IconName, MaestroMark } from '../Icon';
import { Card, Mono } from '../ui';

type Tab = 'inapp' | 'push';

interface Notif {
  icon: IconName;
  tint: keyof ReturnType<typeof useTints>;
  msg: string;
  proj: string;
  t: string;
  unread?: boolean;
}

const NOTIFS: { day: string; rows: Notif[] }[] = [
  {
    day: 'Today',
    rows: [
      { icon: 'arrowRight', tint: 'orange', msg: 'PsychGate needs approval — plan ready', proj: 'Atlas API', t: '2m', unread: true },
      { icon: 'checkCircle', tint: 'green', msg: 'Build finished · $1.12 · 14 min', proj: 'Atlas API', t: '20m', unread: true },
      { icon: 'send', tint: 'teal', msg: 'Published video to YouTube', proj: 'Q3 Content', t: '1h' },
      { icon: 'gauge', tint: 'orange', msg: 'Market Scan at 90% of cap', proj: 'Market Scan', t: '2h' },
    ],
  },
  {
    day: 'Yesterday',
    rows: [
      { icon: 'xCircle', tint: 'red', msg: 'Job failed — render timeout', proj: 'Brand Refresh', t: '18h' },
      { icon: 'shield', tint: 'indigo', msg: 'Skill quarantined: figma-export', proj: 'Workspace', t: '21h' },
      { icon: 'clock', tint: 'blue', msg: 'Nightly test suite fired', proj: 'Atlas API', t: '1d' },
    ],
  },
];

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

function Pulse({ color, size = 9 }: { color: string; size?: number }) {
  const a = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(a, { toValue: 0.35, duration: 900, useNativeDriver: true }),
        Animated.timing(a, { toValue: 1, duration: 900, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [a]);
  return <Animated.View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: color, opacity: a }} />;
}

function PushHeading({ children }: { children: React.ReactNode }) {
  const { theme } = useTheme();
  return (
    <Text style={{ fontSize: 13, fontWeight: '600', letterSpacing: 0.4, textTransform: 'uppercase', color: theme.color.inkTertiary, marginBottom: 10 }}>
      {children}
    </Text>
  );
}

function InAppList() {
  const { theme } = useTheme();
  const tints = useTints();
  return (
    <>
      {NOTIFS.map((section) => (
        <View key={section.day} style={{ marginBottom: 12 }}>
          <Text style={{ fontSize: 13, fontWeight: '600', letterSpacing: 0.4, textTransform: 'uppercase', color: theme.color.inkSecondary, paddingHorizontal: 20, paddingTop: 4, paddingBottom: 8 }}>
            {section.day}
          </Text>
          <View style={{ marginHorizontal: 16, backgroundColor: theme.color.bgElevated, borderRadius: 14, borderWidth: 0.5, borderColor: theme.color.separator, overflow: 'hidden' }}>
            {section.rows.map((r, i) => {
              const tint = tints[r.tint];
              return (
                <View key={i} style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 13, paddingHorizontal: 15, borderBottomWidth: i < section.rows.length - 1 ? 0.5 : 0, borderBottomColor: theme.color.separator }}>
                  <View style={{ width: 34, height: 34, borderRadius: 10, alignItems: 'center', justifyContent: 'center', backgroundColor: tint + '24' }}>
                    <Icon name={r.icon} size={18} color={tint} />
                  </View>
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text style={{ fontSize: 15, lineHeight: 19, fontWeight: r.unread ? '600' : '500', color: theme.color.ink }}>{r.msg}</Text>
                    <Text style={{ fontSize: 12, color: theme.color.inkTertiary, marginTop: 3 }}>{r.proj} · {r.t}</Text>
                  </View>
                  {r.unread ? <View style={{ width: 9, height: 9, borderRadius: 5, backgroundColor: theme.color.blue }} /> : null}
                </View>
              );
            })}
          </View>
        </View>
      ))}
    </>
  );
}

function PushDesigns() {
  const { theme } = useTheme();
  return (
    <View style={{ paddingHorizontal: 20, paddingBottom: 24, gap: 16 }}>
      {/* lock-screen push */}
      <View>
        <PushHeading>Lock screen · gate</PushHeading>
        <Card style={{ borderRadius: 18, overflow: 'hidden' } as any}>
          <View style={{ flexDirection: 'row', gap: 11, padding: 14 }}>
            <View style={{ width: 36, height: 36, borderRadius: 9, alignItems: 'center', justifyContent: 'center', backgroundColor: theme.color.orange + '24' }}>
              <Icon name="arrowRight" size={18} color={theme.color.orange} />
            </View>
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={{ fontSize: 15, lineHeight: 18, fontWeight: '600', color: theme.color.ink }}>PsychGate needs approval</Text>
              <Text style={{ fontSize: 13, lineHeight: 18, color: theme.color.inkSecondary, marginTop: 3 }}>Plan ready: migrate auth to NestJS guards · ≈ $0.60</Text>
            </View>
            <Text style={{ fontSize: 12, color: theme.color.inkTertiary }}>now</Text>
          </View>
          <View style={{ flexDirection: 'row', borderTopWidth: 0.5, borderTopColor: theme.color.separator }}>
            <Pressable style={{ flex: 1, paddingVertical: 12, alignItems: 'center', borderRightWidth: 0.5, borderRightColor: theme.color.separator }}>
              <Text style={{ fontSize: 15, fontWeight: '600', color: theme.color.blue }}>Approve</Text>
            </Pressable>
            <Pressable style={{ flex: 1, paddingVertical: 12, alignItems: 'center' }}>
              <Text style={{ fontSize: 15, fontWeight: '500', color: theme.color.inkSecondary }}>View</Text>
            </Pressable>
          </View>
        </Card>
      </View>

      {/* stacked thread */}
      <View>
        <PushHeading>Stacked · per project</PushHeading>
        <View>
          <View style={{ position: 'absolute', top: 10, left: 12, right: 12, height: 30, borderRadius: 16, backgroundColor: theme.color.bgElevated, borderWidth: 0.5, borderColor: theme.color.separator, opacity: 0.6 }} />
          <View style={{ position: 'absolute', top: 5, left: 6, right: 6, height: 40, borderRadius: 16, backgroundColor: theme.color.bgElevated, borderWidth: 0.5, borderColor: theme.color.separator, opacity: 0.8 }} />
          <Card style={{ flexDirection: 'row', gap: 11, padding: 14, borderRadius: 16 } as any}>
            <MaestroMark size={32} />
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={{ fontSize: 14, lineHeight: 17, fontWeight: '600', color: theme.color.ink }}>Atlas API · 3 notifications</Text>
              <Text style={{ fontSize: 13, lineHeight: 17, color: theme.color.inkSecondary, marginTop: 3 }}>Build finished, gate raised, tests passed</Text>
            </View>
          </Card>
        </View>
      </View>

      {/* live activity */}
      <View>
        <PushHeading>Live Activity</PushHeading>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 14, paddingHorizontal: 18, borderRadius: 20, backgroundColor: '#000' }}>
          <Pulse color={theme.color.purple} />
          <Text style={{ flex: 1, fontSize: 14, fontWeight: '600', color: '#fff' }}>Refactor auth · Building</Text>
          <View style={{ flex: 1, height: 4, borderRadius: 2, backgroundColor: 'rgba(255,255,255,0.2)', overflow: 'hidden' }}>
            <View style={{ width: '64%', height: '100%', backgroundColor: theme.color.blue }} />
          </View>
          <Mono style={{ fontSize: 14, fontWeight: '600', color: '#fff' }}>$0.84</Mono>
        </View>
      </View>
    </View>
  );
}

export function NotificationsScreen() {
  const { theme } = useTheme();
  const insets = useSafeAreaInsets();
  const nav = useNavigation<any>();
  const [tab, setTab] = useState<Tab>('inapp');

  const tabs: { key: Tab; label: string }[] = [
    { key: 'inapp', label: 'In-app' },
    { key: 'push', label: 'Push designs' },
  ];

  return (
    <View style={{ flex: 1, backgroundColor: theme.color.bg }}>
      <ScrollView contentContainerStyle={{ paddingTop: insets.top + 6, paddingBottom: 24 }} showsVerticalScrollIndicator={false}>
        {/* back */}
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 16, paddingTop: 2, paddingBottom: 4 }}>
          <Pressable onPress={() => nav.goBack()} hitSlop={8}>
            <Icon name="arrowLeft" size={22} color={theme.color.blue} />
          </Pressable>
        </View>

        {/* large title */}
        <View style={{ paddingHorizontal: 20, paddingTop: 6, paddingBottom: 10, flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between' }}>
          <Text style={{ fontSize: 34, fontWeight: '700', letterSpacing: -0.7, color: theme.color.ink }}>Activity</Text>
          <Pressable>
            <Text style={{ fontSize: 15, fontWeight: '500', color: theme.color.blue }}>Mark all read</Text>
          </Pressable>
        </View>

        {/* segmented toggle */}
        <View style={{ flexDirection: 'row', gap: 6, paddingHorizontal: 16, paddingTop: 4, paddingBottom: 16 }}>
          {tabs.map((t) => {
            const on = tab === t.key;
            return (
              <Pressable
                key={t.key}
                onPress={() => setTab(t.key)}
                style={{ height: 30, paddingHorizontal: 14, borderRadius: 15, alignItems: 'center', justifyContent: 'center', backgroundColor: on ? theme.color.blue : theme.color.fillSecondary }}
              >
                <Text style={{ fontSize: 13, fontWeight: '600', color: on ? '#fff' : theme.color.inkSecondary }}>{t.label}</Text>
              </Pressable>
            );
          })}
        </View>

        {tab === 'inapp' ? <InAppList /> : <PushDesigns />}
      </ScrollView>
    </View>
  );
}
