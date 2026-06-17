import React from 'react';
import { View, Text, Pressable, ScrollView, StyleSheet, ActivityIndicator } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNavigation, useRoute } from '@react-navigation/native';
import { useTheme } from '../theme';
import { Icon } from '../Icon';
import { cardShadow, Mono } from '../ui';
import { api, ApiError, type JobDiff, type DiffFile, type DiffLine } from '../api';

export function DiffReviewScreen() {
  const { theme } = useTheme();
  const insets = useSafeAreaInsets();
  const nav = useNavigation<any>();
  const route = useRoute<any>();
  const jobId: string | undefined = route.params?.jobId;

  const [diff, setDiff] = React.useState<JobDiff | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [active, setActive] = React.useState(0);

  const load = React.useCallback(() => {
    if (!jobId) { setLoading(false); setError('No job selected.'); return; }
    setLoading(true);
    api.getJobDiff(jobId)
      .then((d) => { setDiff(d); setError(null); setActive(0); })
      .catch((e) => setError(e instanceof ApiError ? e.message : 'Could not load the diff.'))
      .finally(() => setLoading(false));
  }, [jobId]);

  React.useEffect(() => { load(); }, [load]);

  const files: DiffFile[] = diff?.files ?? [];
  const file: DiffFile | undefined = files[active];

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
        <Pressable onPress={() => nav.goBack()} hitSlop={8}>
          <Icon name="arrowLeft" size={22} color={theme.color.blue} />
        </Pressable>
        <View style={{ flex: 1, minWidth: 0, alignItems: 'center' }}>
          <Text style={{ fontSize: 13, fontWeight: '500', color: theme.color.inkTertiary }}>
            {files.length ? `${active + 1} of ${files.length} ${files.length === 1 ? 'file' : 'files'}` : 'Diff review'}
          </Text>
          <Text
            numberOfLines={1}
            style={{ fontFamily: theme.fontFamily.mono, fontSize: 14, fontWeight: '600', color: theme.color.ink, marginTop: 3, maxWidth: 240 }}
          >
            {file?.path ?? '—'}
          </Text>
        </View>
        {file ? (
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
            <Text style={{ fontSize: 11, fontWeight: '600', color: theme.color.blue }}>{file.lang}</Text>
          </View>
        ) : (
          <View style={{ width: 30 }} />
        )}
      </View>

      {loading ? (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
          <ActivityIndicator color={theme.color.blue} />
        </View>
      ) : error ? (
        <EmptyState icon="shield" title={error} hint="Make sure your Mac is online in the Maestro desktop app." onRetry={load} theme={theme} />
      ) : !files.length ? (
        <EmptyState
          icon="check"
          title={diff?.reason ?? 'No changes yet'}
          hint={diff?.reason ? undefined : 'This job hasn’t modified any tracked files.'}
          onRetry={load}
          theme={theme}
        />
      ) : (
        <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 120 }} showsVerticalScrollIndicator={false}>
          {/* summary card — real diffstat */}
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
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
              <Mono style={{ fontSize: 15, fontWeight: '600', color: theme.color.green }}>+{diff?.additions ?? 0}</Mono>
              <Mono style={{ fontSize: 15, fontWeight: '600', color: theme.color.red }}>−{diff?.deletions ?? 0}</Mono>
              <View style={{ flex: 1 }} />
              <Text style={{ fontSize: 13, fontWeight: '500', color: theme.color.inkTertiary }}>
                {files.length} {files.length === 1 ? 'file' : 'files'}
                {diff?.base ? ` · vs ${diff.base}` : ''}
              </Text>
            </View>
            {diff?.truncated ? (
              <Text style={{ fontSize: 12, color: theme.color.orange, marginTop: 10 }}>
                Large diff — showing the first part of the changes.
              </Text>
            ) : null}
          </View>

          {/* diff body for the active file */}
          {file ? (
            <View
              style={{
                backgroundColor: theme.color.bgElevated,
                borderRadius: 14,
                borderWidth: StyleSheet.hairlineWidth,
                borderColor: theme.color.separator,
                overflow: 'hidden',
              }}
            >
              {file.binary ? (
                <View style={{ padding: 18, alignItems: 'center' }}>
                  <Text style={{ fontSize: 13, color: theme.color.inkTertiary }}>Binary file — not shown</Text>
                </View>
              ) : (
                <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                  <View>
                    {file.lines.map((l, i) => (
                      <DiffRow key={i} line={l} theme={theme} />
                    ))}
                  </View>
                </ScrollView>
              )}
            </View>
          ) : null}

          {/* file dots — tap to switch files */}
          {files.length > 1 ? (
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: 8, marginTop: 16 }}>
              {files.map((_, i) => (
                <Pressable key={i} onPress={() => setActive(i)} hitSlop={6}>
                  <View
                    style={{
                      width: 8,
                      height: 8,
                      borderRadius: 4,
                      backgroundColor: i === active ? theme.color.blue : theme.color.fillSecondary,
                    }}
                  />
                </Pressable>
              ))}
            </View>
          ) : null}
        </ScrollView>
      )}

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
          onPress={() => nav.goBack()}
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
          <Icon name="check" size={16} color="#fff" />
          <Text style={{ fontSize: 16, fontWeight: '600', color: '#fff' }}>Done</Text>
        </Pressable>
        <Pressable
          onPress={load}
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

function DiffRow({ line: l, theme }: { line: DiffLine; theme: ReturnType<typeof useTheme>['theme'] }) {
  if (l.t === 'hunk') {
    return (
      <View style={{ paddingVertical: 6, paddingHorizontal: 12, backgroundColor: theme.color.fillTertiary, minWidth: '100%' }}>
        <Text style={{ fontFamily: theme.fontFamily.mono, fontSize: 12, fontWeight: '500', color: theme.color.inkTertiary }}>{l.c}</Text>
      </View>
    );
  }
  return (
    <View
      style={{
        flexDirection: 'row',
        minWidth: '100%',
        backgroundColor: l.t === 'add' ? theme.color.diffAdd : l.t === 'del' ? theme.color.diffDel : 'transparent',
      }}
    >
      <Text style={{ width: 38, textAlign: 'right', paddingRight: 8, fontFamily: theme.fontFamily.mono, fontSize: 12, lineHeight: 22, color: theme.color.inkTertiary }}>
        {l.n}
      </Text>
      <Text style={{ width: 14, textAlign: 'center', fontFamily: theme.fontFamily.mono, fontSize: 12, lineHeight: 22, color: l.t === 'add' ? theme.color.green : l.t === 'del' ? theme.color.red : 'transparent' }}>
        {l.t === 'add' ? '+' : l.t === 'del' ? '−' : ''}
      </Text>
      <Text style={{ paddingRight: 16, fontFamily: theme.fontFamily.mono, fontSize: 12, lineHeight: 22, color: theme.color.ink }}>
        {l.c || ' '}
      </Text>
    </View>
  );
}

function EmptyState({
  icon, title, hint, onRetry, theme,
}: {
  icon: 'shield' | 'check';
  title: string;
  hint?: string;
  onRetry: () => void;
  theme: ReturnType<typeof useTheme>['theme'];
}) {
  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32, gap: 12 }}>
      <Icon name={icon} size={34} color={theme.color.inkTertiary} />
      <Text style={{ fontSize: 16, fontWeight: '600', color: theme.color.ink, textAlign: 'center' }}>{title}</Text>
      {hint ? <Text style={{ fontSize: 13, lineHeight: 19, color: theme.color.inkTertiary, textAlign: 'center' }}>{hint}</Text> : null}
      <Pressable onPress={onRetry} style={{ marginTop: 8, height: 40, paddingHorizontal: 20, borderRadius: 20, backgroundColor: theme.color.fillSecondary, alignItems: 'center', justifyContent: 'center' }}>
        <Text style={{ fontSize: 14, fontWeight: '600', color: theme.color.blue }}>Retry</Text>
      </Pressable>
    </View>
  );
}
