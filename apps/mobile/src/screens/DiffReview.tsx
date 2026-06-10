import React from 'react';
import { View, Text, Pressable, ScrollView, StyleSheet } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import { useTheme } from '../theme';
import { Icon } from '../Icon';
import { cardShadow, Mono } from '../ui';

type Severity = 'red' | 'amber' | 'grey';
type Finding = { sev: Severity; t: string };
type DiffKind = 'ctx' | 'add' | 'del';
type DiffLine = { t: DiffKind; n: string; c: string; fold?: boolean };

const FINDINGS: Finding[] = [
  { sev: 'amber', t: 'Bearer parse assumes a "Bearer " prefix.' },
  { sev: 'grey', t: 'clearSession is now explicitly typed.' },
];

const DIFF: DiffLine[] = [
  { t: 'ctx', n: '1', c: "import { store } from '../db';" },
  { t: 'add', n: '2', c: "import { verifyJwt } from './jwt';" },
  { t: 'ctx', n: '', c: '··· 8 unchanged lines', fold: true },
  { t: 'ctx', n: '11', c: 'export async function getSession(req) {' },
  { t: 'del', n: '', c: "  const sid = req.cookies['sid'];" },
  { t: 'del', n: '', c: '  return store.get(sid);' },
  { t: 'add', n: '12', c: '  const bearer = req.headers.authorization?.slice(7);' },
  { t: 'add', n: '13', c: '  if (bearer) {' },
  { t: 'add', n: '14', c: '    const claims = verifyJwt(bearer);' },
  { t: 'add', n: '15', c: '    if (claims) return store.get(claims.sid);' },
  { t: 'add', n: '16', c: '  }' },
  { t: 'ctx', n: '17', c: '}' },
];

const FILE_COUNT = 12;
const ACTIVE_FILE = 2;

export function DiffReviewScreen() {
  const { theme } = useTheme();
  const insets = useSafeAreaInsets();
  const nav = useNavigation<any>();

  const sevColor: Record<Severity, string> = {
    red: theme.color.red,
    amber: theme.color.orange,
    grey: theme.color.inkTertiary,
  };

  return (
    <View style={{ flex: 1, backgroundColor: theme.color.bg }}>
      {/* header */}
      <View
        style={{
          paddingTop: insets.top + 4,
          paddingHorizontal: 16,
          paddingBottom: 10,
          flexDirection: 'row',
          alignItems: 'center',
          gap: 10,
          borderBottomWidth: StyleSheet.hairlineWidth,
          borderBottomColor: theme.color.separator,
        }}
      >
        <Pressable onPress={() => nav.navigate('Approvals')} hitSlop={8}>
          <Icon name="arrowLeft" size={22} color={theme.color.blue} />
        </Pressable>
        <View style={{ flex: 1, minWidth: 0, alignItems: 'center' }}>
          <Text style={{ fontSize: 13, fontWeight: '500', color: theme.color.inkTertiary }}>3 of 12 files</Text>
          <Text
            numberOfLines={1}
            style={{ fontFamily: theme.fontFamily.mono, fontSize: 14, fontWeight: '600', color: theme.color.ink, marginTop: 3 }}
          >
            src/auth/session.ts
          </Text>
        </View>
        <View
          style={{
            height: 22,
            paddingHorizontal: 8,
            borderRadius: 11,
            backgroundColor: theme.color.blue + '21',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Text style={{ fontSize: 11, fontWeight: '600', color: theme.color.blue }}>TS</Text>
        </View>
      </View>

      <ScrollView
        contentContainerStyle={{ padding: 16, paddingBottom: 120 }}
        showsVerticalScrollIndicator={false}
      >
        {/* summary card */}
        <View
          style={[
            {
              backgroundColor: theme.color.bgElevated,
              borderRadius: 16,
              borderWidth: StyleSheet.hairlineWidth,
              borderColor: theme.color.separator,
              padding: 16,
              marginBottom: 16,
            },
            cardShadow(),
          ]}
        >
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 12 }}>
            <Mono style={{ fontSize: 15, fontWeight: '600', color: theme.color.green }}>+204</Mono>
            <Mono style={{ fontSize: 15, fontWeight: '600', color: theme.color.red }}>−67</Mono>
            <View style={{ flex: 1 }} />
            <View
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: 5,
                height: 24,
                paddingHorizontal: 10,
                borderRadius: theme.radius.pill,
                backgroundColor: 'rgba(255,149,0,0.14)',
              }}
            >
              <Icon name="shield" size={12} color={theme.color.orange} />
              <Text style={{ fontSize: 13, fontWeight: '600', color: theme.color.orange }}>2 issues</Text>
            </View>
          </View>

          <Text style={{ fontSize: 15, lineHeight: 22, color: theme.color.ink, marginBottom: 14 }}>
            Moves session reads to short-lived JWTs with a legacy cookie fallback. Adds a reversible migration and 24
            tests.
          </Text>

          <View style={{ gap: 8 }}>
            {FINDINGS.map((f, i) => (
              <Pressable
                key={i}
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 9,
                  paddingVertical: 10,
                  paddingHorizontal: 12,
                  borderRadius: 10,
                  backgroundColor: theme.color.fillTertiary,
                }}
              >
                <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: sevColor[f.sev] }} />
                <Text style={{ flex: 1, fontSize: 14, lineHeight: 18, color: theme.color.ink }}>{f.t}</Text>
                <Icon name="chevronRight" size={15} color={theme.color.inkTertiary} />
              </Pressable>
            ))}
          </View>
        </View>

        {/* diff */}
        <View
          style={{
            backgroundColor: theme.color.bgElevated,
            borderRadius: 14,
            borderWidth: StyleSheet.hairlineWidth,
            borderColor: theme.color.separator,
            overflow: 'hidden',
          }}
        >
          {DIFF.map((l, i) =>
            l.fold ? (
              <View
                key={i}
                style={{
                  paddingVertical: 6,
                  paddingHorizontal: 12,
                  alignItems: 'center',
                  backgroundColor: theme.color.fillTertiary,
                }}
              >
                <Text style={{ fontSize: 12, fontWeight: '500', color: theme.color.inkTertiary }}>{l.c}</Text>
              </View>
            ) : (
              <View
                key={i}
                style={{
                  flexDirection: 'row',
                  backgroundColor:
                    l.t === 'add' ? theme.color.diffAdd : l.t === 'del' ? theme.color.diffDel : 'transparent',
                }}
              >
                <Text
                  style={{
                    width: 30,
                    textAlign: 'right',
                    paddingRight: 8,
                    fontFamily: theme.fontFamily.mono,
                    fontSize: 12,
                    lineHeight: 22,
                    color: theme.color.inkTertiary,
                  }}
                >
                  {l.n}
                </Text>
                <Text
                  style={{
                    width: 14,
                    textAlign: 'center',
                    fontFamily: theme.fontFamily.mono,
                    fontSize: 12,
                    lineHeight: 22,
                    color: l.t === 'add' ? theme.color.green : l.t === 'del' ? theme.color.red : 'transparent',
                  }}
                >
                  {l.t === 'add' ? '+' : l.t === 'del' ? '−' : ''}
                </Text>
                <Text
                  numberOfLines={1}
                  style={{
                    flex: 1,
                    paddingRight: 10,
                    fontFamily: theme.fontFamily.mono,
                    fontSize: 12,
                    lineHeight: 22,
                    color: theme.color.ink,
                  }}
                >
                  {l.c}
                </Text>
              </View>
            ),
          )}
        </View>

        {/* file dots */}
        <View style={{ flexDirection: 'row', justifyContent: 'center', gap: 6, marginTop: 16 }}>
          {Array.from({ length: FILE_COUNT }).map((_, i) => (
            <View
              key={i}
              style={{
                width: 6,
                height: 6,
                borderRadius: 3,
                backgroundColor: i === ACTIVE_FILE ? theme.color.blue : theme.color.fillSecondary,
              }}
            />
          ))}
        </View>
      </ScrollView>

      {/* action bar */}
      <View
        style={{
          position: 'absolute',
          bottom: 0,
          left: 0,
          right: 0,
          flexDirection: 'row',
          alignItems: 'center',
          gap: 10,
          paddingHorizontal: 16,
          paddingTop: 12,
          paddingBottom: insets.bottom + 12,
          backgroundColor: theme.color.bgGrouped,
          borderTopWidth: StyleSheet.hairlineWidth,
          borderTopColor: theme.color.separator,
        }}
      >
        <Pressable
          onPress={() => nav.navigate('Approvals')}
          style={({ pressed }) => [
            {
              flex: 1,
              height: 50,
              borderRadius: theme.radius.pill,
              backgroundColor: theme.color.blue,
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 7,
              transform: [{ scale: pressed ? 0.97 : 1 }],
            },
            cardShadow(),
          ]}
        >
          <Icon name="lock" size={15} color="#fff" />
          <Text style={{ fontSize: 16, fontWeight: '600', color: '#fff' }}>Approve & merge</Text>
        </Pressable>
        <Pressable
          style={({ pressed }) => ({
            width: 50,
            height: 50,
            borderRadius: 25,
            backgroundColor: theme.color.fillSecondary,
            alignItems: 'center',
            justifyContent: 'center',
            transform: [{ scale: pressed ? 0.97 : 1 }],
          })}
        >
          <Icon name="refresh" size={19} color={theme.color.inkSecondary} />
        </Pressable>
      </View>
    </View>
  );
}
