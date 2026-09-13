import { Stack } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { useEffect, useState } from 'react';
import { LogBox, StatusBar } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { BottomSheetModalProvider } from '@gorhom/bottom-sheet';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { useIconFonts } from '@/src/hooks/use-icon-fonts';
import { getDb } from '@/src/db';
import { NotesApi } from '@/src/api/client';
import { migrateStorageNamespace } from '@/src/state/storageKeys';
import { ThemeProvider, useTheme } from '@/src/theme/ThemeContext';
import { useAppSettings } from '@/src/state/useAppSettings';
import { ToastProvider } from '@/src/components/Toast';

LogBox.ignoreAllLogs(true);

// Keep splash visible until icon fonts register (prevents Android Expo Go crash).
SplashScreen.preventAutoHideAsync();

function ThemedStack() {
  const { isDark, colors } = useTheme();
  const { settings } = useAppSettings();
  return (
    <>
      <StatusBar
        barStyle={isDark ? 'light-content' : 'dark-content'}
        backgroundColor={colors.surface}
        hidden={settings.statusBarHidden}
      />
      <Stack
        initialRouteName="index"
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: colors.surface },
          animation: 'slide_from_right',
        }}
      >
        <Stack.Screen name="index" />
        <Stack.Screen
          name="settings"
          options={{
            presentation: 'transparentModal',
            animation: 'slide_from_right',
            contentStyle: { backgroundColor: 'transparent' },
          }}
        />
      </Stack>
    </>
  );
}

export default function RootLayout() {
  const [loaded, error] = useIconFonts();
  const [dbReady, setDbReady] = useState(false);

  // Open and migrate the local database before any screen renders, so no screen
  // has to guard against a database that is not there yet.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        await getDb();
        await migrateStorageNamespace();
        // The server used to purge old trash on a daily timer. With no server,
        // startup is the honest place to do it.
        await NotesApi.purgeExpiredTrash(30);
      } catch (e) {
        // A failure here means the notes list will surface the error itself;
        // blocking startup forever would be worse.
        console.warn('startup', e);
      } finally {
        if (!cancelled) setDbReady(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if ((loaded || error) && dbReady) {
      SplashScreen.hideAsync();
    }
  }, [loaded, error, dbReady]);

  if ((!loaded && !error) || !dbReady) return null;

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <ThemeProvider>
          <BottomSheetModalProvider>
            <ToastProvider>
              <ThemedStack />
            </ToastProvider>
          </BottomSheetModalProvider>
        </ThemeProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
