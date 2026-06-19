/* App-wide live alerter. Mounted once (App.tsx), it listens to the shared SSE
   stream and, when a run completes or a gate needs attention, fires a loud alert
   (sound + haptics + OS notification) and shows an in-app banner. Honors the
   per-category toggles in Settings (notifPrefs). Dedupes per job/approval. */

import React, { useEffect, useRef, useState } from 'react';
import { Animated, Pressable, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from './theme';
import { Icon, type IconName } from './Icon';
import { useLive } from './useLive';
import { fireAlert, notify, playAlertSound, setupAlerts } from './alerts';
import { eventAllowed } from './notifPrefs';
import { navRef } from './navRef';
import type { PushNavData } from './pushNav';
import { routeFor } from './pushNav';
import { api } from './api';

type Banner = { tint: string; icon: IconName; title: string; body: string; nav?: PushNavData };

export function LiveNotifier() {
  const { theme } = useTheme();
  const insets = useSafeAreaInsets();
  const seen = useRef<Set<string>>(new Set());
  const [banner, setBanner] = useState<Banner | null>(null);
  const slide = useRef(new Animated.Value(-120)).current;
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => { void setupAlerts(); }, []);

  const show = (b: Banner) => {
    setBanner(b);
    Animated.spring(slide, { toValue: 0, useNativeDriver: true, friction: 8, tension: 80 }).start();
    if (hideTimer.current) clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(dismiss, 4500);
  };
  const dismiss = () => {
    Animated.timing(slide, { toValue: -160, duration: 220, useNativeDriver: true }).start(() => setBanner(null));
  };

  useLive(['job', 'approval', 'schedule-late'], (name, data) => {
    if (name === 'schedule-late') {
      const s = data as { id?: string; title?: string; firedAt?: number; projectId?: string; sessionId?: string } | null;
      const k = `late:${s?.id ?? ''}:${s?.firedAt ?? ''}`;
      if (seen.current.has(k)) return; seen.current.add(k);
      const nav: PushNavData = { kind: 'schedule-late', projectId: s?.projectId, sessionId: s?.sessionId };
      fireAlert('Scheduled task ran late', s?.title ? `“${s.title}” caught up.` : 'A schedule caught up after a missed time.', nav);
      show({ tint: theme.color.orange, icon: 'clock', title: 'Ran late', body: s?.title ? `“${s.title}” caught up.` : 'A schedule caught up after a missed time.', nav });
      return;
    }
    if (name === 'job') {
      const j = data as { id?: string; status?: string; title?: string; projectId?: string; sessionId?: string } | null;
      if (!j?.id) return;
      const base = { projectId: j.projectId, sessionId: j.sessionId, jobId: j.id };
      if (j.status === 'done' && eventAllowed('job-done')) {
        const k = `${j.id}:done`; if (seen.current.has(k)) return; seen.current.add(k);
        const nav: PushNavData = { kind: 'job-done', ...base };
        fireAlert('Conversation complete', j.title || 'A run finished on your Mac.', nav);
        show({ tint: theme.color.green, icon: 'checkCircle', title: 'Conversation complete', body: j.title || 'A run finished on your Mac.', nav });
      } else if (j.status === 'failed' && eventAllowed('job-failed')) {
        const k = `${j.id}:failed`; if (seen.current.has(k)) return; seen.current.add(k);
        const nav: PushNavData = { kind: 'job-failed', ...base };
        fireAlert('Job failed', j.title || 'A run failed on your Mac.', nav);
        show({ tint: theme.color.red, icon: 'xCircle', title: 'Job failed', body: j.title || 'A run failed on your Mac.', nav });
      }
    } else if (name === 'approval') {
      const a = data as { id?: string; status?: string; title?: string; projectId?: string | null; jobId?: string | null } | null;
      if (a?.id && a.status === 'pending' && eventAllowed('approval-created')) {
        const k = `appr:${a.id}`; if (seen.current.has(k)) return; seen.current.add(k);
        const approvalId = a.id;
        const title = 'Needs your attention';
        const body = a.title || 'An approval is waiting.';
        // Approval payloads don't carry sessionId — we resolve it by jobId so
        // the tap lands on the originating chat. Play the chime + show the
        // in-app banner immediately for snappy UX; defer the OS notification
        // (which is what the user might tap from the tray later) until after
        // we know sessionId, so its `data` carries the full deep-link.
        const initialNav: PushNavData = { kind: 'approval', approvalId, projectId: a.projectId ?? undefined, jobId: a.jobId ?? undefined };
        playAlertSound();
        show({ tint: theme.color.orange, icon: 'shield', title, body, nav: initialNav });
        const finalize = (nav: PushNavData) => {
          void notify(title, body, nav);
          // Patch the in-app banner if it's still the same one — so foreground
          // tap on the banner gets the enriched route too.
          setBanner((cur) => cur && cur.nav?.kind === 'approval' && cur.nav.approvalId === approvalId
            ? { ...cur, nav }
            : cur);
        };
        if (a.jobId) {
          const jobId = a.jobId;
          void api.getJob(jobId).then((job) => {
            finalize({ ...initialNav, projectId: initialNav.projectId ?? job?.projectId, sessionId: job?.sessionId });
          }).catch(() => {
            // Offline / unknown job — still schedule the OS notification so the
            // tray has something tappable (falls back to the Approvals tab).
            finalize(initialNav);
          });
        } else {
          finalize(initialNav);
        }
      }
    }
  });

  const openBanner = () => {
    // Mirror what a closed-app tap does: route to the originating session chat
    // (or Approvals when there's no session). Always dismiss the banner after.
    try {
      const target = routeFor(banner?.nav ?? null);
      if (target && navRef.isReady()) {
        if (target.name === 'SessionChat' && target.params) navRef.navigate('SessionChat', target.params);
        else if (target.name === 'Approvals') navRef.navigate('Tabs', { screen: 'Approvals' } as never);
      }
    } catch { /* nav not ready — fall through to dismiss */ }
    dismiss();
  };

  if (!banner) return null;
  return (
    <Animated.View
      pointerEvents="box-none"
      style={{ position: 'absolute', top: 0, left: 0, right: 0, paddingTop: insets.top + 6, paddingHorizontal: 12, transform: [{ translateY: slide }], zIndex: 100 }}
    >
      <Pressable
        onPress={openBanner}
        style={{
          flexDirection: 'row', alignItems: 'center', gap: 12, padding: 14, borderRadius: 16,
          backgroundColor: theme.color.bgElevated, borderWidth: 1, borderColor: banner.tint + '55',
          shadowColor: '#000', shadowOpacity: 0.28, shadowRadius: 16, shadowOffset: { width: 0, height: 8 }, elevation: 10,
        }}
      >
        <View style={{ width: 38, height: 38, borderRadius: 11, alignItems: 'center', justifyContent: 'center', backgroundColor: banner.tint + '24' }}>
          <Icon name={banner.icon} size={20} color={banner.tint} />
        </View>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={{ fontSize: 15, fontWeight: '700', color: theme.color.ink }}>{banner.title}</Text>
          <Text numberOfLines={1} style={{ fontSize: 13, color: theme.color.inkSecondary, marginTop: 2 }}>{banner.body}</Text>
        </View>
      </Pressable>
    </Animated.View>
  );
}
