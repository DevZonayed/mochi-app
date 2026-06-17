import React from 'react';
import { NavigationContainer, DefaultTheme, DarkTheme, type Theme as NavTheme } from '@react-navigation/native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { useTheme } from './theme';
import { Icon, type IconName } from './Icon';
import { getFlag, ONBOARDED } from './storage';
import { api } from './api';
import { useLive } from './useLive';

import { HomeScreen } from './screens/Home';
import { JobsScreen } from './screens/Jobs';
import { ApprovalsScreen } from './screens/Approvals';
import { StudioScreen } from './screens/Studio';
import { SettingsScreen } from './screens/Settings';
import { OnboardingScreen } from './screens/Onboarding';
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

export type RootStackParamList = {
  Tabs: undefined;
  Onboarding: undefined;
  JobTimeline: { id?: string; jobId?: string } | undefined;
  DiffReview: { jobId?: string } | undefined;
  NewJob: { projectId?: string } | undefined;
  Budget: undefined;
  Notifications: undefined;
  Outbox: undefined;
  ProjectSessions: { projectId: string; name: string };
  SessionChat: { projectId: string; sessionId?: string; title?: string };
  Queue: undefined;
};

const Tab = createBottomTabNavigator();
const Stack = createNativeStackNavigator<RootStackParamList>();

const TAB_ICON: Record<string, IconName> = {
  Home: 'home',
  Projects: 'folder',
  Jobs: 'jobs',
  Approvals: 'shield',
  Studio: 'clapper',
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
      <Tab.Screen name="Jobs" component={JobsScreen} />
      <Tab.Screen name="Approvals" component={ApprovalsScreen} options={{ tabBarBadge: pending > 0 ? pending : undefined }} />
      <Tab.Screen name="Studio" component={StudioScreen} />
      <Tab.Screen name="Settings" component={SettingsScreen} />
    </Tab.Navigator>
  );
}

export function RootNavigator() {
  const { theme, mode } = useTheme();
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
  return (
    <NavigationContainer theme={navTheme}>
      <Stack.Navigator screenOptions={{ headerShown: false }} initialRouteName={getFlag(ONBOARDED) ? 'Tabs' : 'Onboarding'}>
        <Stack.Screen name="Tabs" component={Tabs} />
        <Stack.Screen name="Onboarding" component={OnboardingScreen} />
        <Stack.Screen name="JobTimeline" component={JobTimelineScreen} />
        <Stack.Screen name="DiffReview" component={DiffReviewScreen} />
        <Stack.Screen name="NewJob" component={NewJobScreen} options={{ presentation: 'modal' }} />
        <Stack.Screen name="Budget" component={BudgetScreen} />
        <Stack.Screen name="Notifications" component={NotificationsScreen} />
        <Stack.Screen name="Outbox" component={OutboxScreen} />
        <Stack.Screen name="ProjectSessions" component={ProjectSessionsScreen} />
        <Stack.Screen name="SessionChat" component={SessionChatScreen} />
        <Stack.Screen name="Queue" component={QueueScreen} />
      </Stack.Navigator>
    </NavigationContainer>
  );
}
