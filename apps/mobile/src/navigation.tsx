import React from 'react';
import { NavigationContainer, DefaultTheme, DarkTheme, type Theme as NavTheme } from '@react-navigation/native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { useTheme } from './theme';
import { Icon, type IconName } from './Icon';
import { getFlag, ONBOARDED } from './storage';
import { api } from './api';

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

export type RootStackParamList = {
  Tabs: undefined;
  Onboarding: undefined;
  JobTimeline: undefined;
  DiffReview: undefined;
  NewJob: undefined;
  Budget: undefined;
  Notifications: undefined;
  Outbox: undefined;
};

const Tab = createBottomTabNavigator();
const Stack = createNativeStackNavigator<RootStackParamList>();

const TAB_ICON: Record<string, IconName> = {
  Home: 'home',
  Jobs: 'jobs',
  Approvals: 'shield',
  Studio: 'clapper',
  Settings: 'settings',
};

function Tabs() {
  const { theme } = useTheme();
  // Live pending-approvals badge — poll every 15s (RN has no SSE).
  const [pending, setPending] = React.useState(0);
  React.useEffect(() => {
    let alive = true;
    const refresh = () => api.listApprovals('pending').then(a => { if (alive) setPending(a.length); }).catch(() => {});
    refresh();
    const t = setInterval(refresh, 15000);
    return () => { alive = false; clearInterval(t); };
  }, []);
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
      </Stack.Navigator>
    </NavigationContainer>
  );
}
