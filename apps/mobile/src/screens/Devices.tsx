/* Device switcher — pick which Mac (host) this phone controls. Lists every host
   on the account with its live online state; selecting one sets the persisted
   "active host" that scopes all sync, commands, and the live stream. */

import React, { useCallback, useState } from 'react';
import { View, Text, Pressable, ScrollView, ActivityIndicator, RefreshControl, StyleSheet } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useFocusEffect, useNavigation, useRoute } from '@react-navigation/native';
import { useTheme } from '../theme';
import { Icon } from '../Icon';
import { api, ApiError, type Device } from '../api';
import { getActiveHost, setActiveHost } from '../auth';
import { reloadForActiveHost } from '../syncStore';

function fmtLastSeen(ts?: number): string {
  if (!ts) return '';
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

export function DevicesScreen() {
  const { theme } = useTheme();
  const insets = useSafeAreaInsets();
  const nav = useNavigation<any>();
  const route = useRoute();
  const firstRun = (route.params as { firstRun?: boolean } | undefined)?.firstRun ?? false;

  const [devices, setDevices] = useState<Device[] | null>(null);
  const [active, setActive] = useState(getActiveHost());
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true);
    setError(null);
    try {
      const list = await api.listDevices();
      const hosts = list.filter((d) => d.role === 'host');
      setDevices(hosts);
      // Default the active host to the first ONLINE one on first run / when none set.
      const current = getActiveHost();
      if (!current || !hosts.some((h) => h.id === current)) {
        const pick = hosts.find((h) => h.online) ?? hosts[0];
        if (pick) { setActiveHost(pick.id); setActive(pick.id); reloadForActiveHost(); }
      }
    } catch (e) {
      // 401 already bounced to Login (see api). Show other failures.
      setError(e instanceof ApiError ? e.message : 'Couldn’t load your Macs.');
      setDevices((d) => d ?? []);
    } finally {
      if (isRefresh) setRefreshing(false);
    }
  }, []);

  useFocusEffect(useCallback(() => { void load(); }, [load]));

  const pick = (d: Device) => {
    if (!d.online) return; // can't drive an offline Mac
    setActiveHost(d.id);
    setActive(d.id);
    reloadForActiveHost(); // swap to that host's slice + fresh pull + the live stream re-points
    if (firstRun) nav.reset({ index: 0, routes: [{ name: 'Tabs' }] });
    else if (nav.canGoBack()) nav.goBack();
  };

  const loading = devices === null;

  return (
    <View style={{ flex: 1, backgroundColor: theme.color.bg }}>
      <View style={{ paddingTop: insets.top + 6, paddingHorizontal: 20, paddingBottom: 8, flexDirection: 'row', alignItems: 'center', gap: 12 }}>
        {!firstRun && nav.canGoBack() ? (
          <Pressable onPress={() => nav.goBack()} hitSlop={10}>
            <Icon name="arrowLeft" size={24} color={theme.color.ink} />
          </Pressable>
        ) : null}
        <Text style={{ fontSize: 30, fontWeight: '700', letterSpacing: -0.6, color: theme.color.ink }}>Your Macs</Text>
      </View>
      <Text style={{ paddingHorizontal: 20, paddingBottom: 12, fontSize: 15, color: theme.color.inkSecondary, lineHeight: 20 }}>
        Choose which Mac to control. Everything you do runs on the selected one.
      </Text>

      {loading ? (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
          <ActivityIndicator color={theme.color.blue} />
        </View>
      ) : (
        <ScrollView
          contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: insets.bottom + 24 }}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void load(true)} tintColor={theme.color.inkSecondary} />}
        >
          {error ? (
            <View style={{ padding: 16, borderRadius: 12, backgroundColor: theme.color.red + '14', marginBottom: 14 }}>
              <Text style={{ color: theme.color.red, fontSize: 14, fontWeight: '500' }}>{error}</Text>
            </View>
          ) : null}

          {devices.length === 0 ? (
            <View style={{ alignItems: 'center', paddingVertical: 60, paddingHorizontal: 24 }}>
              <View style={{ width: 64, height: 64, borderRadius: 18, backgroundColor: theme.color.fillSecondary, alignItems: 'center', justifyContent: 'center', marginBottom: 18 }}>
                <Icon name="smartphone" size={30} color={theme.color.inkTertiary} />
              </View>
              <Text style={{ color: theme.color.ink, fontSize: 18, fontWeight: '600', marginBottom: 8, textAlign: 'center' }}>No Macs yet</Text>
              <Text style={{ color: theme.color.inkSecondary, fontSize: 15, lineHeight: 21, textAlign: 'center' }}>
                Open Maestro on your Mac and sign in with this same account. It’ll show up here automatically.
              </Text>
              <Pressable onPress={() => void load(true)} style={{ marginTop: 22, flexDirection: 'row', alignItems: 'center', gap: 8, height: 44, paddingHorizontal: 20, borderRadius: theme.radius.pill, backgroundColor: theme.color.fillSecondary }}>
                <Icon name="refresh" size={16} color={theme.color.ink} />
                <Text style={{ color: theme.color.ink, fontSize: 15, fontWeight: '600' }}>Refresh</Text>
              </Pressable>
            </View>
          ) : (
            <View style={{ backgroundColor: theme.color.bgElevated, borderRadius: 14, overflow: 'hidden', borderWidth: StyleSheet.hairlineWidth, borderColor: theme.color.separator }}>
              {devices.map((d, i) => {
                const selected = d.id === active;
                return (
                  <Pressable
                    key={d.id}
                    onPress={() => pick(d)}
                    style={({ pressed }) => ({
                      flexDirection: 'row', alignItems: 'center', gap: 14, padding: 16,
                      borderBottomWidth: i === devices.length - 1 ? 0 : StyleSheet.hairlineWidth,
                      borderBottomColor: theme.color.separator,
                      opacity: d.online ? (pressed ? 0.7 : 1) : 0.55,
                    })}
                  >
                    <View style={{ width: 44, height: 44, borderRadius: 12, backgroundColor: theme.color.fillSecondary, alignItems: 'center', justifyContent: 'center' }}>
                      <Icon name="command" size={22} color={theme.color.inkSecondary} />
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={{ color: theme.color.ink, fontSize: 17, fontWeight: '600' }}>{d.name || 'Mac'}</Text>
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 4 }}>
                        <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: d.online ? theme.color.green : theme.color.inkTertiary }} />
                        <Text style={{ fontSize: 13, fontWeight: '500', color: d.online ? theme.color.green : theme.color.inkTertiary }}>
                          {d.online ? 'Online' : `Offline${d.lastSeen ? ` · ${fmtLastSeen(d.lastSeen)}` : ''}`}
                        </Text>
                      </View>
                    </View>
                    {selected ? (
                      <View style={{ width: 26, height: 26, borderRadius: 13, backgroundColor: theme.color.blue, alignItems: 'center', justifyContent: 'center' }}>
                        <Icon name="check" size={16} color="#fff" stroke={3} />
                      </View>
                    ) : d.online ? (
                      <Icon name="chevronRight" size={18} color={theme.color.inkTertiary} />
                    ) : null}
                  </Pressable>
                );
              })}
            </View>
          )}
        </ScrollView>
      )}
    </View>
  );
}
