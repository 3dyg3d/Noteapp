import { Tabs } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { Platform, StyleSheet } from 'react-native';
import { BlurView } from 'expo-blur';

import { useTheme } from '@/src/theme/ThemeContext';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

export default function TabsLayout() {
  const { colors, isDark } = useTheme();
  const insets = useSafeAreaInsets();

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: colors.brand,
        tabBarInactiveTintColor: colors.muted,
        tabBarLabelStyle: { fontSize: 11, fontWeight: '600' },
        tabBarStyle: {
          position: 'absolute',
          backgroundColor: Platform.OS === 'web' ? colors.surface : 'transparent',
          borderTopColor: colors.divider,
          borderTopWidth: 0.5,
          height: 56 + insets.bottom,
          paddingBottom: insets.bottom,
          paddingTop: 6,
        },
        tabBarBackground:
          Platform.OS === 'web'
            ? undefined
            : () => (
                <BlurView
                  intensity={isDark ? 50 : 80}
                  tint={isDark ? 'dark' : 'light'}
                  style={[StyleSheet.absoluteFillObject, { backgroundColor: colors.surface + 'ee' }]}
                />
              ),
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: 'Notes',
          tabBarIcon: ({ color, size }) => <Ionicons name="document-text" size={size} color={color} />,
        }}
      />
      <Tabs.Screen
        name="settings"
        options={{
          title: 'Settings',
          tabBarIcon: ({ color, size }) => <Ionicons name="settings" size={size} color={color} />,
        }}
      />
    </Tabs>
  );
}
