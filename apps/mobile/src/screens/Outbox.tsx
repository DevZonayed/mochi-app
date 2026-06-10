import React from 'react';
import { View, Text, Pressable, ScrollView } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import { useTheme } from '../theme';
import { Icon, type IconName } from '../Icon';
import { cardShadow } from '../ui';

type IntentState = 'queued' | 'applied' | 'rejected' | 'conflict';

const INTENTS: {
  id: string;
  icon: IconName;
  tint: keyof ReturnType<typeof useTints>;
  desc: string;
  t: string;
  state: IntentState;
  why?: string;
}[] = [
  { id: 'i1', icon: 'sliders', tint: 'blue', desc: 'Approve plan — PsychGate', t: '2 min ago', state: 'queued' },
  { id: 'i2', icon: 'play', tint: 'purple', desc: 'Start job — Kvanti research', t: '5 min ago', state: 'queued' },
  { id: 'i3', icon: 'gitMerge', tint: 'green', desc: 'Approve merge — PR #482', t: '8 min ago', state: 'applied' },
  { id: 'i4', icon: 'gauge', tint: 'orange', desc: 'Raise cap — Market Scan', t: '11 min ago', state: 'rejected', why: "Couldn't apply: this gate timed out at 09:14" },
  { id: 'i5', icon: 'send', tint: 'teal', desc: 'Publish — Launch thread', t: '14 min ago', state: 'conflict', why: 'Already approved on your Mac — nothing to do.' },
];

function useTints() {
  const { theme } = useTheme();
  return { blue: theme.color.blue, purple: theme.color.purple, orange: theme.color.orange, teal: theme.color.teal, green: theme.color.green };
}

export function OutboxScreen() {
  const { theme } = useTheme();
  const insets = useSafeAreaInsets();
  const tints = useTints();
  const nav = useNavigation<any>();

  return (
    <View style={{ flex: 1, backgroundColor: theme.color.bg }}>
      {/* offline banner */}
      <View
        style={{
          paddingTop: insets.top,
          backgroundColor: 'rgba(255,149,0,0.14)',
          borderBottomWidth: 0.5,
          borderBottomColor: 'rgba(255,149,0,0.3)',
        }}
      >
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 8, paddingHorizontal: 16 }}>
          <Icon name="refresh" size={14} color={theme.color.orange} />
          <Text style={{ flex: 1, fontSize: 13, fontWeight: '500', color: theme.color.orange }}>Offline — showing state from 4 min ago</Text>
        </View>
      </View>

      <ScrollView contentContainerStyle={{ paddingBottom: 24 }} showsVerticalScrollIndicator={false}>
        {/* back button row */}
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 16, paddingTop: 6, paddingBottom: 2 }}>
          <Pressable onPress={() => nav.navigate('Tabs', { screen: 'Settings' })} hitSlop={8}>
            <Icon name="arrowLeft" size={22} color={theme.color.blue} />
          </Pressable>
        </View>

        {/* large title */}
        <View style={{ paddingHorizontal: 20, paddingTop: 6, paddingBottom: 10 }}>
          <Text style={{ fontSize: 34, fontWeight: '700', letterSpacing: -0.7, color: theme.color.ink }}>Outbox</Text>
        </View>

        <View style={{ paddingHorizontal: 16, paddingTop: 6, gap: 12 }}>
          {INTENTS.map((it) => {
            const done = it.state === 'applied';
            const bad = it.state === 'rejected';
            const conflict = it.state === 'conflict';
            const tint = tints[it.tint];

            const bg = done ? 'rgba(52,199,89,0.07)' : bad ? 'rgba(255,59,48,0.06)' : theme.color.bgElevated;
            const border = done
              ? 'rgba(52,199,89,0.3)'
              : bad
                ? 'rgba(255,59,48,0.3)'
                : it.state === 'queued'
                  ? 'rgba(255,149,0,0.4)'
                  : theme.color.separator;

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
                    <Icon name={it.icon} size={19} color={tint} />
                  </View>
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text style={{ fontSize: 16, fontWeight: '600', color: theme.color.ink }}>{it.desc}</Text>
                    <Text style={{ fontSize: 13, color: theme.color.inkTertiary, marginTop: 3 }}>{it.t}</Text>
                  </View>
                  {it.state === 'queued' ? (
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5, height: 24, paddingHorizontal: 10, borderRadius: 12, backgroundColor: 'rgba(255,149,0,0.15)' }}>
                      <Icon name="clock" size={11} color={theme.color.orange} />
                      <Text style={{ fontSize: 12, fontWeight: '600', color: theme.color.orange }}>Queued</Text>
                    </View>
                  ) : null}
                  {done ? <Icon name="checkCircle" size={22} color={theme.color.green} /> : null}
                  {it.state === 'queued' ? (
                    <Pressable style={{ width: 26, height: 26, borderRadius: 13, backgroundColor: theme.color.fillSecondary, alignItems: 'center', justifyContent: 'center', marginLeft: 4 }} hitSlop={6}>
                      <Icon name="x" size={13} color={theme.color.inkTertiary} />
                    </Pressable>
                  ) : null}
                </View>

                {bad || conflict ? (
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 11, paddingTop: 11, borderTopWidth: 0.5, borderTopColor: theme.color.separator }}>
                    <Icon name={bad ? 'xCircle' : 'check'} size={14} color={bad ? theme.color.red : theme.color.inkTertiary} />
                    <Text style={{ flex: 1, fontSize: 13, lineHeight: 18, color: bad ? theme.color.red : theme.color.inkSecondary }}>{it.why}</Text>
                    {bad ? (
                      <Pressable onPress={() => nav.navigate('JobTimeline')} hitSlop={6}>
                        <Text style={{ fontSize: 13, fontWeight: '600', color: theme.color.blue }}>View job</Text>
                      </Pressable>
                    ) : null}
                  </View>
                ) : null}
              </View>
            );
          })}

          <Text style={{ fontSize: 13, lineHeight: 19, color: theme.color.inkTertiary, textAlign: 'center', paddingTop: 8, paddingHorizontal: 20 }}>
            Applies in order when your Mac is reachable. Each action carries a one-time token — nothing runs twice.
          </Text>
        </View>
      </ScrollView>
    </View>
  );
}
