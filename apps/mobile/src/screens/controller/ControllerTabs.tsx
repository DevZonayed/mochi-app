/**
 * ControllerTabs — Bottom-tab navigator for the secure controller mode. Replaces the
 * old drawer/sidebar ShadowShell with a proper iOS-style tab bar: Home, Projects, Chat,
 * Screen, More. Each tab gets its own screen component; drill-in navigation within a
 * tab uses internal route state (not nested navigators). The ShadowUiState and
 * ShadowUiController are shared via React context so every tab accesses the SAME
 * gated projection and action environment.
 */
import React from 'react';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { useTheme } from '../../theme';
import { Icon, type IconName } from '../../Icon';
import type { ShadowUiState } from '../../shadowUiModel';
import type { ShadowUiController } from '../../shadowUiController';
import { ActionEnvProvider } from './ActionControls';
import { ControllerProvider } from './ControllerContext';
import { ControllerHome } from './ControllerHome';
import { ControllerProjects } from './ControllerProjects';
import { ControllerMessages } from './ControllerMessages';
import { ControllerRemote } from './ControllerRemote';
import { ControllerSettings } from './ControllerSettings';

// ── tabs ───────────────────────────────────────────────────────────────────
const TAB_ICON: Record<string, IconName> = {
  Home: 'home',
  Projects: 'folder',
  Chat: 'messageCircle',
  Screen: 'monitor',
  More: 'more',
};

const Tab = createBottomTabNavigator();

export function ControllerTabs({ state, controller }: { state: ShadowUiState; controller: ShadowUiController }) {
  const { theme } = useTheme();
  const env = { granted: state.enrollment.grantedCapabilities, online: state.connection.online };

  // Counts for badges
  const proj = controller.projection();
  const approvals = proj.pendingApprovals().length;
  const questions = proj.pendingQuestions().length;
  const attention = approvals + questions;

  const ctxValue = React.useMemo(() => ({ state, controller }), [state, controller]);

  return (
    <ControllerProvider value={ctxValue}>
      <ActionEnvProvider granted={env.granted} online={env.online}>
        <Tab.Navigator
          screenOptions={({ route }) => ({
            headerShown: false,
            tabBarActiveTintColor: theme.color.blue,
            tabBarInactiveTintColor: theme.color.inkTertiary,
            tabBarStyle: {
              backgroundColor: theme.color.bgElevated,
              borderTopColor: theme.color.separator,
              borderTopWidth: 0.5,
              paddingTop: 4,
            },
            tabBarLabelStyle: { fontSize: 10, fontWeight: '600' },
            tabBarIcon: ({ color, focused }) => (
              <Icon name={TAB_ICON[route.name]} size={24} color={color} stroke={focused ? 2.2 : 1.75} />
            ),
          })}
        >
          <Tab.Screen name="Home" component={ControllerHome} />
          <Tab.Screen name="Projects" component={ControllerProjects} />
          <Tab.Screen name="Chat" component={ControllerMessages} />
          <Tab.Screen name="Screen" component={ControllerRemote} />
          <Tab.Screen
            name="More"
            component={ControllerSettings}
            options={{ tabBarBadge: attention > 0 ? attention : undefined }}
          />
        </Tab.Navigator>
      </ActionEnvProvider>
    </ControllerProvider>
  );
}
