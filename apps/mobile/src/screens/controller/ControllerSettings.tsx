/**
 * ControllerSettings — Settings & More tab for the controller bottom bar. Contains:
 * - Connection status card
 * - Controller device info + Mac fingerprint
 * - Granted permissions list
 * - Screen access status
 * - Pending approvals queue (with action controls)
 * - Open questions (with answer controls)
 * - Schedules list
 * - Request additional access
 * - Sign out
 */
import React from 'react';
import { View, Text, ScrollView } from 'react-native';
import { useTheme } from '../../theme';
import { Icon } from '../../Icon';
import { signOut } from '../../auth';
import { activeControllerAccountId, deactivateControllerModeForAccount } from '../../controllerMode';
import { signOutSecureController } from '../../controllerRoot';
import { resetProductionShadowController } from '../../shadowProductionController';
import { capabilityLabel } from '../../shadowUiModel';
import { useController } from './ControllerContext';
import { useActionEnv, ApprovalControl, AnswerQuestionControl } from './ActionControls';
import { Screen, StatusChip, GhostButton, ConnBadge, useInsets } from './parts';

export function ControllerSettings() {
  const { theme } = useTheme();
  const { state, controller } = useController();
  const env = useActionEnv();
  const insets = useInsets();

  const e = state.enrollment;
  const proj = controller.projection();
  const approvals = proj.pendingApprovals();
  const questions = proj.pendingQuestions();
  const schedules = proj.schedules();
  const screenViewGranted = e.grantedCapabilityLabels.includes(capabilityLabel('screen.view'));
  const perms = e.grantedCapabilityLabels.length ? e.grantedCapabilityLabels : e.requestedCapabilityLabels;

  return (
    <Screen>
      <ScrollView contentContainerStyle={{ paddingTop: insets.top + 12, paddingHorizontal: 16, paddingBottom: insets.bottom + 24 }}>
        {/* Title */}
        <Text style={{ fontSize: 32, fontWeight: '700', letterSpacing: -0.6, color: theme.color.ink, marginBottom: 20 }}>Settings</Text>

        {/* Connection card */}
        <SectionLabel title="Connection" />
        <View style={{ backgroundColor: theme.color.bgElevated, borderRadius: 14, borderWidth: 0.5, borderColor: theme.color.separator, padding: 16, marginBottom: 20, flexDirection: 'row', alignItems: 'center', gap: 14 }}>
          <View style={{ width: 44, height: 44, borderRadius: 14, backgroundColor: (state.connection.online ? theme.color.green : theme.color.orange) + '18', alignItems: 'center', justifyContent: 'center' }}>
            <Icon name={state.connection.online ? 'wifi' : 'wifiOff'} size={22} color={state.connection.online ? theme.color.green : theme.color.orange} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={{ fontSize: 16, fontWeight: '600', color: theme.color.ink }}>{state.connection.online ? 'Connected' : 'Offline'}</Text>
            <Text style={{ fontSize: 13, color: theme.color.inkSecondary, marginTop: 2 }}>
              {state.connection.online ? 'Syncing with your Mac' : 'Mac is unreachable'}
            </Text>
          </View>
          <ConnBadge online={state.connection.online} />
        </View>

        {/* Controller device */}
        <SectionLabel title="Controller device" />
        <SettingsCard>
          <SettingsRow label="This device" value={e.controllerDeviceIdShort ?? '---'} mono />
          <SettingsRow label="Mac fingerprint" value={e.hostFingerprintShort ?? '---'} mono last />
        </SettingsCard>

        {/* Granted permissions */}
        <SectionLabel title="Granted permissions" />
        <SettingsCard>
          {perms.map((label, i) => (
            <View key={label} style={{ flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 44, borderBottomWidth: i === perms.length - 1 ? 0 : 0.5, borderBottomColor: theme.color.separator }}>
              <Icon name="check" size={15} color={theme.color.green} stroke={2.4} />
              <Text style={{ flex: 1, fontSize: 14, color: theme.color.ink }}>{label}</Text>
            </View>
          ))}
        </SettingsCard>

        {/* Screen access */}
        <SectionLabel title="Screen access" />
        <SettingsCard>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 46 }}>
            <Icon name={screenViewGranted ? 'check' : 'lock'} size={15} color={screenViewGranted ? theme.color.green : theme.color.inkTertiary} stroke={2.4} />
            <View style={{ flex: 1 }}>
              <Text style={{ fontSize: 14, color: theme.color.ink }}>View Mac screen</Text>
              <Text style={{ fontSize: 12, color: theme.color.inkTertiary, marginTop: 1 }}>View only · no control or audio</Text>
            </View>
            <StatusChip tone={screenViewGranted ? 'online' : 'neutral'} label={screenViewGranted ? 'Granted' : 'Not granted'} />
          </View>
        </SettingsCard>
        <Text style={{ fontSize: 12, color: theme.color.inkTertiary, paddingHorizontal: 4, marginBottom: 16 }}>
          {screenViewGranted ? 'Switch to the Screen tab to view your Mac.' : 'Re-connect and check "View Mac screen" to enable.'}
        </Text>

        {/* Approvals queue */}
        {approvals.length > 0 ? (
          <>
            <SectionLabel title={`Approvals (${approvals.length})`} />
            {approvals.map((a) => (
              <View key={a.id} style={{ backgroundColor: theme.color.bgElevated, borderRadius: 14, borderWidth: 0.5, borderColor: theme.color.separator, padding: 14, marginBottom: 8 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 8 }}>
                  <View style={{ width: 34, height: 34, borderRadius: 10, backgroundColor: theme.color.orange + '20', alignItems: 'center', justifyContent: 'center' }}>
                    <Icon name="shield" size={17} color={theme.color.orange} />
                  </View>
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text numberOfLines={1} style={{ fontSize: 15, fontWeight: '600', color: theme.color.ink }}>{a.title ?? 'Approval'}</Text>
                    {a.summary ? <Text numberOfLines={1} style={{ fontSize: 12, color: theme.color.inkTertiary, marginTop: 2 }}>{a.summary}</Text> : null}
                  </View>
                  <StatusChip tone="pending" label="Pending" />
                </View>
                <ApprovalControl approval={a} granted={env.granted} online={env.online} />
              </View>
            ))}
            <View style={{ height: 8 }} />
          </>
        ) : null}

        {/* Questions */}
        {questions.length > 0 ? (
          <>
            <SectionLabel title={`Questions (${questions.length})`} />
            {questions.map((q) => (
              <View key={q.id} style={{ backgroundColor: theme.color.bgElevated, borderRadius: 14, borderWidth: 0.5, borderColor: theme.color.separator, padding: 14, marginBottom: 8 }}>
                <Text numberOfLines={2} style={{ fontSize: 15, fontWeight: '600', color: theme.color.ink, marginBottom: 8 }}>{q.question ?? 'Question'}</Text>
                <AnswerQuestionControl question={q} granted={env.granted} online={env.online} />
              </View>
            ))}
            <View style={{ height: 8 }} />
          </>
        ) : null}

        {/* Schedules */}
        {schedules.length > 0 ? (
          <>
            <SectionLabel title={`Schedules (${schedules.length})`} />
            <SettingsCard>
              {schedules.map((s, i) => {
                const nextRun = s.nextRun ? (() => { try { return new Date(s.nextRun).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }); } catch { return null; } })() : null;
                return (
                  <View key={s.id} style={{ flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 48, borderBottomWidth: i === schedules.length - 1 ? 0 : 0.5, borderBottomColor: theme.color.separator }}>
                    <View style={{ width: 30, height: 30, borderRadius: 8, backgroundColor: theme.color.indigo + '20', alignItems: 'center', justifyContent: 'center' }}>
                      <Icon name="calendar" size={15} color={theme.color.indigo} />
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text numberOfLines={1} style={{ fontSize: 14, fontWeight: '600', color: theme.color.ink }}>{s.title ?? 'Schedule'}</Text>
                      <Text style={{ fontSize: 12, color: theme.color.inkTertiary, marginTop: 1 }}>{[s.cadence, nextRun && `next ${nextRun}`].filter(Boolean).join(' · ') || '---'}</Text>
                    </View>
                    <StatusChip tone={s.enabled ? 'online' : 'neutral'} label={s.enabled ? 'Active' : 'Off'} />
                  </View>
                );
              })}
            </SettingsCard>
          </>
        ) : null}

        {/* Additional access */}
        <View style={{ marginTop: 8 }}>
          <Text style={{ fontSize: 13, color: theme.color.inkTertiary, marginBottom: 10 }}>
            Need this device to do more? Re-connect and choose extra actions.
          </Text>
          <GhostButton title="Request additional access" onPress={() => { void controller.retryEnrollment(); }} />
        </View>

        <View style={{ height: 20 }} />

        {/* Sign out */}
        <GhostButton title="Sign out" tone="danger" onPress={() => void doSignOut()} />
      </ScrollView>
    </Screen>
  );
}

function doSignOut(): Promise<void> {
  return signOutSecureController({
    resetController: resetProductionShadowController,
    signOut,
    captureAccountId: activeControllerAccountId,
    deactivateForAccount: deactivateControllerModeForAccount,
  });
}

// ── shared components ─────────────────────────────────────────────────────
function SectionLabel({ title }: { title: string }) {
  const { theme } = useTheme();
  return <Text style={{ fontSize: 13, fontWeight: '700', letterSpacing: 0.4, textTransform: 'uppercase', color: theme.color.inkSecondary, marginBottom: 8 }}>{title}</Text>;
}

function SettingsCard({ children }: { children: React.ReactNode }) {
  const { theme } = useTheme();
  return <View style={{ backgroundColor: theme.color.bgElevated, borderRadius: 14, borderWidth: 0.5, borderColor: theme.color.separator, paddingHorizontal: 14, marginBottom: 16 }}>{children}</View>;
}

function SettingsRow({ label, value, mono, last }: { label: string; value: string; mono?: boolean; last?: boolean }) {
  const { theme } = useTheme();
  return (
    <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', minHeight: 46, gap: 12, borderBottomWidth: last ? 0 : 0.5, borderBottomColor: theme.color.separator }}>
      <Text style={{ fontSize: 14, color: theme.color.inkTertiary }}>{label}</Text>
      <Text numberOfLines={1} style={{ flex: 1, textAlign: 'right', fontSize: 14, fontWeight: '600', color: theme.color.ink, fontFamily: mono ? 'Menlo' : undefined }}>{value}</Text>
    </View>
  );
}
