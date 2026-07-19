import React from 'react';
import { View } from 'react-native';
import { NavigationContainer, DefaultTheme, DarkTheme, type Theme as NavTheme } from '@react-navigation/native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { useTheme } from './theme';
import { Icon, type IconName } from './Icon';
import { api } from './api';
import { isAuthed } from './auth';
import { useLive } from './useLive';
import { navRef } from './navRef';
import { flushPendingNav } from './pushNav';
import { subscribeControllerMode, isControllerModeActive, isControllerModeRestored } from './controllerMode';
import { chooseRootTree } from './controllerRoot';

import { HomeScreen } from './screens/Home';
import { ApprovalsScreen } from './screens/Approvals';
import { SettingsScreen } from './screens/Settings';
import { LoginScreen, RegisterScreen } from './screens/Auth';
import { DevicesScreen } from './screens/Devices';
import { JobTimelineScreen } from './screens/JobTimeline';
import { DiffReviewScreen } from './screens/DiffReview';
import { NewJobScreen } from './screens/NewJob';
import { BudgetScreen } from './screens/Budget';
import { NotificationsScreen } from './screens/Notifications';
import { OutboxScreen } from './screens/Outbox';
import { ProjectsScreen } from './screens/Projects';
import { ProjectSessionsScreen } from './screens/ProjectSessions';
import { SessionChatScreen } from './screens/SessionChat';
import { QueueScreen } from './screens/Queue';
import { CreateProjectScreen } from './screens/CreateProject';
import { ControllerScreen } from './screens/controller/ControllerScreen';

export type RootStackParamList = {
  Tabs: undefined;
  Login: undefined;
  Register: undefined;
  Devices: { firstRun?: boolean } | undefined;
  JobTimeline: { id?: string; jobId?: string } | undefined;
  DiffReview: { jobId?: string } | undefined;
  NewJob: { projectId?: string } | undefined;
  Budget: undefined;
  Notifications: undefined;
  Outbox: undefined;
  ProjectSessions: { projectId: string; name: string };
  SessionChat: { projectId: string; sessionId?: string; title?: string };
  Queue: undefined;
  CreateProject: undefined;
};

/** Secure-controller root param list — a SEPARATE tree with NO route back into the
    legacy tabs/stack (no Back/Home into the direct-API app). */
export type ControllerStackParamList = {
  ControllerRoot: undefined;
};

const Tab = createBottomTabNavigator();
const Stack = createNativeStackNavigator<RootStackParamList>();

const TAB_ICON: Record<string, IconName> = {
  Home: 'home',
  Projects: 'folder',
  Approvals: 'shield',
  Settings: 'settings',
};

function Tabs() {
  const { theme } = useTheme();
  // Live pending-approvals badge — SSE-driven, with a slow poll backstop.
  const [pending, setPending] = React.useState(0);
  const refresh = React.useCallback(() => { api.listApprovals('pending').then(a => setPending(a.length)).catch(() => {}); }, []);
  React.useEffect(() => { refresh(); const t = setInterval(refresh, 20000); return () => clearInterval(t); }, [refresh]);
  useLive(['approval'], refresh);
  return (
    <Tab.Navigator
      screenOptions={({ route }) => ({
        headerShown: false,
        tabBarActiveTintColor: theme.color.blue,
        tabBarInactiveTintColor: theme.color.inkTertiary,
        tabBarStyle: { backgroundColor: theme.color.bgElevated, borderTopColor: theme.color.separator },
        tabBarIcon: ({ color, focused }) => <Icon name={TAB_ICON[route.name]} size={25} color={color} stroke={focused ? 2.4 : 1.9} />,
      })}
    >
      <Tab.Screen name="Home" component={HomeScreen} />
      <Tab.Screen name="Projects" component={ProjectsScreen} />
      <Tab.Screen name="Approvals" component={ApprovalsScreen} options={{ tabBarBadge: pending > 0 ? pending : undefined }} />
      <Tab.Screen name="Settings" component={SettingsScreen} />
    </Tab.Navigator>
  );
}

const ControllerStack = createNativeStackNavigator<ControllerStackParamList>();

// Encoded controller-mode snapshot (a stable primitive for useSyncExternalStore).
const MODE_PENDING = 0, MODE_INACTIVE = 1, MODE_ACTIVE = 2;
function modeSnapshot(): number {
  if (!isControllerModeRestored()) return MODE_PENDING;
  return isControllerModeActive() ? MODE_ACTIVE : MODE_INACTIVE;
}
/** Subscribe to the persisted secure-controller mode (restore state + active flag). */
function useControllerMode(): { restored: boolean; active: boolean } {
  const s = React.useSyncExternalStore(subscribeControllerMode, modeSnapshot, () => MODE_PENDING);
  return { restored: s !== MODE_PENDING, active: s === MODE_ACTIVE };
}

/** Neutral splash while the controller-mode marker is being restored — NEVER the
    legacy tabs (prevents a one-frame legacy flash before the tree is chosen). */
function ModeSplash() {
  const { theme } = useTheme();
  return <View style={{ flex: 1, backgroundColor: theme.color.bg }} />;
}

export function RootNavigator() {
  const { theme, mode } = useTheme();
  const { restored, active } = useControllerMode();
  const base = mode === 'dark' ? DarkTheme : DefaultTheme;
  const navTheme: NavTheme = {
    ...base,
    colors: {
      ...base.colors,
      background: theme.color.bg,
      card: theme.color.bgElevated,
      text: theme.color.ink,
      border: theme.color.separator,
      primary: theme.color.blue,
    },
  };

  // ROOT decision: exactly one tree, from the single pure `chooseRootTree`.
  //   splash     → neutral loading while the marker restores (never the legacy tabs)
  //   controller → the secure shell only (no Back/Home into legacy)
  //   auth       → the legacy Stack at Login (signed out)
  //   legacy     → the legacy Stack at Tabs (signed in, mode inactive)
  // `legacy` (authed && restored && !active) is the ONLY tab-mounting branch — sign-out
  // clears auth BEFORE the marker so this branch is never committed mid-sign-out (R1).
  const tree = chooseRootTree(isAuthed(), restored, active);
  if (tree === 'splash') return <ModeSplash />;
  if (tree === 'controller') {
    return (
      <NavigationContainer theme={navTheme} ref={navRef} onReady={flushPendingNav}>
        <ControllerStack.Navigator screenOptions={{ headerShown: false }}>
          <ControllerStack.Screen name="ControllerRoot" component={ControllerScreen} />
        </ControllerStack.Navigator>
      </NavigationContainer>
    );
  }

  return (
    <NavigationContainer theme={navTheme} ref={navRef} onReady={flushPendingNav}>
      <Stack.Navigator screenOptions={{ headerShown: false }} initialRouteName={isAuthed() ? 'Tabs' : 'Login'}>
        <Stack.Screen name="Tabs" component={Tabs} />
        <Stack.Screen name="Login" component={LoginScreen} />
        <Stack.Screen name="Register" component={RegisterScreen} />
        <Stack.Screen name="Devices" component={DevicesScreen} />
        <Stack.Screen name="JobTimeline" component={JobTimelineScreen} />
        <Stack.Screen name="DiffReview" component={DiffReviewScreen} />
        <Stack.Screen name="NewJob" component={NewJobScreen} options={{ presentation: 'modal' }} />
        <Stack.Screen name="Budget" component={BudgetScreen} />
        <Stack.Screen name="Notifications" component={NotificationsScreen} />
        <Stack.Screen name="Outbox" component={OutboxScreen} />
        <Stack.Screen name="ProjectSessions" component={ProjectSessionsScreen} />
        <Stack.Screen name="SessionChat" component={SessionChatScreen} />
        <Stack.Screen name="Queue" component={QueueScreen} />
        <Stack.Screen name="CreateProject" component={CreateProjectScreen} options={{ presentation: 'modal' }} />
      </Stack.Navigator>
    </NavigationContainer>
  );
}
