import React, { useEffect, useRef, useState } from 'react';
import { View, Text, Pressable, ScrollView, Animated } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import { useTheme } from '../theme';
import { Icon } from '../Icon';
import { Card, Mono } from '../ui';

const METERS: { value: string; label: string; accent?: boolean }[] = [
  { value: '$0.84', label: 'cost' },
  { value: '12:40', label: 'elapsed' },
  { value: 'BALANCED', label: 'effort', accent: true },
];

const TOOL_OUTPUT = 'PASS  test/auth/session.test.ts\nTests: 24 passed\nTime:  3.18s';

/** Breathing dot — mirrors the design's `.breathe` purple pulse. */
function Breathe({ color, size = 6 }: { color: string; size?: number }) {
  const a = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(a, { toValue: 0.3, duration: 900, useNativeDriver: true }),
        Animated.timing(a, { toValue: 1, duration: 900, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [a]);
  return <Animated.View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: color, opacity: a }} />;
}

/** Blinking caret at the live edge of the transcript. */
function Caret({ color }: { color: string }) {
  const a = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(a, { toValue: 0, duration: 500, useNativeDriver: true }),
        Animated.timing(a, { toValue: 1, duration: 500, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [a]);
  return <Animated.Text style={{ color, fontWeight: '600', opacity: a }}>▍</Animated.Text>;
}

function MeterStrip() {
  const { theme } = useTheme();
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        paddingVertical: 10,
        paddingHorizontal: 20,
        borderBottomWidth: 0.5,
        borderBottomColor: theme.color.separator,
        backgroundColor: theme.color.bgGrouped,
      }}
    >
      {METERS.map((m, i) => (
        <React.Fragment key={i}>
          {i > 0 ? <View style={{ width: 1, height: 26, backgroundColor: theme.color.separator, marginHorizontal: 16 }} /> : null}
          <View style={{ flex: 1 }}>
            <Mono style={{ fontSize: 16, fontWeight: '600', color: m.accent ? theme.color.blue : theme.color.ink }}>{m.value}</Mono>
            <Text style={{ fontSize: 11, color: theme.color.inkTertiary, marginTop: 4 }}>{m.label}</Text>
          </View>
        </React.Fragment>
      ))}
      <Icon name="chevronDown" size={16} color={theme.color.inkTertiary} />
    </View>
  );
}

function PhaseMark({ label }: { label: string }) {
  const { theme } = useTheme();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 4 }}>
      <View style={{ flex: 1, height: 1, backgroundColor: theme.color.separator }} />
      <Text style={{ fontSize: 12, fontWeight: '600', letterSpacing: 0.5, textTransform: 'uppercase', color: theme.color.inkTertiary }}>{label}</Text>
      <View style={{ flex: 1, height: 1, backgroundColor: theme.color.separator }} />
    </View>
  );
}

function Narration({ children, caret }: { children: React.ReactNode; caret?: boolean }) {
  const { theme } = useTheme();
  return (
    <Text style={{ fontSize: 17, lineHeight: 27, color: theme.color.ink }}>
      {children}
      {caret ? <Caret color={theme.color.purple} /> : null}
    </Text>
  );
}

function Tool({ cmd, time }: { cmd: string; time: string }) {
  const { theme } = useTheme();
  const [open, setOpen] = useState(false);
  return (
    <View>
      <Pressable
        onPress={() => setOpen((o) => !o)}
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: 8,
          paddingVertical: 11,
          paddingHorizontal: 13,
          borderTopLeftRadius: 11,
          borderTopRightRadius: 11,
          borderBottomLeftRadius: open ? 0 : 11,
          borderBottomRightRadius: open ? 0 : 11,
          backgroundColor: theme.color.fillSecondary,
        }}
      >
        <View style={{ transform: [{ rotate: open ? '90deg' : '0deg' }] }}>
          <Icon name="chevronRight" size={13} color={theme.color.inkTertiary} />
        </View>
        <Text numberOfLines={1} style={{ flex: 1, fontSize: 14, fontWeight: '500', fontFamily: theme.fontFamily.mono, color: theme.color.ink }}>
          {cmd}
        </Text>
        <Icon name="check" size={13} color={theme.color.green} stroke={2.6} />
        <Mono style={{ fontSize: 12, color: theme.color.inkTertiary }}>{time}</Mono>
      </Pressable>
      {open ? (
        <View
          style={{
            paddingVertical: 11,
            paddingHorizontal: 13,
            backgroundColor: theme.color.bgElevated,
            borderWidth: 0.5,
            borderTopWidth: 0,
            borderColor: theme.color.separator,
            borderBottomLeftRadius: 11,
            borderBottomRightRadius: 11,
          }}
        >
          <Mono style={{ fontSize: 12, lineHeight: 19, color: theme.color.inkSecondary }}>{TOOL_OUTPUT}</Mono>
        </View>
      ) : null}
    </View>
  );
}

export function JobTimelineScreen() {
  const { theme } = useTheme();
  const insets = useSafeAreaInsets();
  const nav = useNavigation<any>();

  return (
    <View style={{ flex: 1, backgroundColor: theme.color.bg }}>
      {/* header */}
      <View
        style={{
          paddingTop: insets.top + 4,
          paddingBottom: 10,
          paddingHorizontal: 16,
          flexDirection: 'row',
          alignItems: 'center',
          gap: 12,
          borderBottomWidth: 0.5,
          borderBottomColor: theme.color.separator,
        }}
      >
        <Pressable onPress={() => nav.goBack()} hitSlop={8}>
          <Icon name="arrowLeft" size={22} color={theme.color.blue} />
        </Pressable>
        <View style={{ flex: 1, minWidth: 0, alignItems: 'center' }}>
          <Text numberOfLines={1} style={{ fontSize: 16, fontWeight: '600', color: theme.color.ink }}>
            Refactor auth service
          </Text>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 3 }}>
            <Breathe color={theme.color.purple} />
            <Text style={{ fontSize: 12, fontWeight: '500', color: theme.color.purple }}>Building · Atlas API</Text>
          </View>
        </View>
        <Pressable hitSlop={8}>
          <Icon name="more" size={22} color={theme.color.inkSecondary} />
        </Pressable>
      </View>

      <MeterStrip />

      {/* timeline body */}
      <ScrollView
        contentContainerStyle={{ padding: 18, paddingBottom: 90, gap: 16 }}
        showsVerticalScrollIndicator={false}
      >
        <PhaseMark label="Plan ✓" />
        <Narration>
          I'll move the auth service to short-lived JWTs while keeping the legacy cookie path intact, then prove it with tests.
        </Narration>
        <Tool cmd="bash · npm test — auth" time="3.2s" />

        <PhaseMark label="Build ●" />
        <Narration>
          The session table needs a migration. Adding a nullable jwt_id column so we can backfill without downtime.
        </Narration>

        <Pressable onPress={() => nav.navigate('DiffReview')}>
          <Card style={{ flexDirection: 'row', alignItems: 'center', gap: 11, padding: 14, borderRadius: 14 } as any}>
            <Icon name="command" size={18} color={theme.color.inkSecondary} />
            <Text style={{ flex: 1, fontSize: 15, fontWeight: '600', color: theme.color.ink }}>12 files changed</Text>
            <Mono style={{ fontSize: 14, fontWeight: '600', color: theme.color.green }}>+204</Mono>
            <Mono style={{ fontSize: 14, fontWeight: '600', color: theme.color.red }}>−67</Mono>
            <Icon name="chevronRight" size={16} color={theme.color.inkTertiary} />
          </Card>
        </Pressable>

        <Tool cmd="bash · npm run typecheck" time="5.1s" />
        <Narration caret>
          Patching the three call sites in routes/ that read req.session directly
        </Narration>
      </ScrollView>

      {/* jump to live pill */}
      <Pressable
        style={{
          position: 'absolute',
          bottom: insets.bottom + 22,
          alignSelf: 'center',
          flexDirection: 'row',
          alignItems: 'center',
          gap: 7,
          height: 40,
          paddingHorizontal: 18,
          borderRadius: 20,
          backgroundColor: theme.color.blue,
        }}
      >
        <Text style={{ color: '#fff', fontSize: 14, fontWeight: '600' }}>Jump to live</Text>
        <Icon name="chevronDown" size={15} color="#fff" />
      </Pressable>
    </View>
  );
}
