import React, { useEffect, useState } from 'react';
import { Stack } from 'expo-router';
import { View, Text, StyleSheet, Platform } from 'react-native';
import { getStore } from '../src/store/store';

function getDeviceNamespace(): string {
  if (Platform.OS === 'web' && typeof window !== 'undefined') {
    const params = new URLSearchParams(window.location.search);
    const ns = params.get('device');
    if (ns) return ns;
    // Auto-assign and redirect
    const newNs = `dev${Math.random().toString(36).substring(2, 6)}`;
    const url = new URL(window.location.href);
    url.searchParams.set('device', newNs);
    window.history.replaceState({}, '', url.toString());
    return newNs;
  }
  return 'mobile';
}

export default function RootLayout() {
  const [ready, setReady] = useState(false);
  const [deviceId, setDeviceId] = useState('');

  useEffect(() => {
    const ns = getDeviceNamespace();
    getStore()
      .init(ns)
      .then(() => {
        setDeviceId(getStore().getState().deviceId);
        setReady(true);
      });
  }, []);

  if (!ready) {
    return (
      <View style={styles.loading}>
        <Text style={styles.loadingText}>Starting Alcovia...</Text>
      </View>
    );
  }

  return (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: '#1a1a2e' },
        headerTintColor: '#fff',
        headerTitleStyle: { fontWeight: '700' },
      }}
    >
      <Stack.Screen name="index" options={{ title: 'Alcovia', headerShown: false }} />
    </Stack>
  );
}

const styles = StyleSheet.create({
  loading: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#1a1a2e' },
  loadingText: { color: '#fff', fontSize: 18 },
});
