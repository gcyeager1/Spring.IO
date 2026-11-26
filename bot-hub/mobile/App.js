import React, { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, BackHandler, Linking, Pressable, SafeAreaView, StyleSheet, Text, View } from "react-native";
import { StatusBar } from "expo-status-bar";
import { WebView } from "react-native-webview";
import Constants from "expo-constants";

// The hosted Bot Hub. Login happens inside the WebView, so the site's own
// session cookie (HttpOnly, SameSite) is used and kept between launches.
const HUB_URL = (process.env.EXPO_PUBLIC_HUB_URL || Constants.expoConfig?.extra?.hubUrl || "https://bots.ezliftgaragedoorservice.com").replace(/\/$/, "");
const HUB_HOST = new URL(HUB_URL).host;

export default function App() {
  const web = useRef(null);
  const [canGoBack, setCanGoBack] = useState(false);
  const [failed, setFailed] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      if (canGoBack && web.current) {
        web.current.goBack();
        return true;
      }
      return false;
    });
    return () => sub.remove();
  }, [canGoBack]);

  // Keep the app on the hub; open anything else in the phone's browser.
  const onShouldStart = useCallback((req) => {
    try {
      const host = new URL(req.url).host;
      // Stay in the WebView for the hub and its Railway host; leaving would drop the session.
      if (host === HUB_HOST || host.endsWith(".up.railway.app")) return true;
    } catch {}
    Linking.openURL(req.url).catch(() => {});
    return false;
  }, []);

  return (
    <SafeAreaView style={styles.root}>
      <StatusBar style="light" />
      {failed ? (
        <View style={styles.center}>
          <Text style={styles.title}>Can't reach Bot Hub</Text>
          <Text style={styles.sub}>{HUB_URL}</Text>
          <Pressable
            style={styles.btn}
            onPress={() => {
              setFailed(false);
              setLoading(true);
              web.current?.reload();
            }}
          >
            <Text style={styles.btnText}>Try again</Text>
          </Pressable>
        </View>
      ) : (
        <WebView
          ref={web}
          source={{ uri: HUB_URL }}
          style={styles.web}
          sharedCookiesEnabled
          thirdPartyCookiesEnabled={true}
          javaScriptEnabled
          domStorageEnabled
          setSupportMultipleWindows={false}
          onShouldStartLoadWithRequest={onShouldStart}
          onNavigationStateChange={(s) => setCanGoBack(s.canGoBack)}
          onLoadEnd={() => setLoading(false)}
          onError={() => setFailed(true)}
          onHttpError={(e) => e.nativeEvent.statusCode >= 500 && setFailed(true)}
        />
      )}
      {loading && !failed && (
        <View style={styles.overlay} pointerEvents="none">
          <ActivityIndicator color="#8b949e" />
        </View>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#0d1117" },
  web: { flex: 1, backgroundColor: "#0d1117" },
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24 },
  title: { color: "#e6edf3", fontSize: 18, fontWeight: "600" },
  sub: { color: "#8b949e", marginTop: 6, marginBottom: 18 },
  btn: { backgroundColor: "#238636", paddingHorizontal: 20, paddingVertical: 10, borderRadius: 8 },
  btnText: { color: "#fff", fontWeight: "600" },
  overlay: { ...StyleSheet.absoluteFillObject, alignItems: "center", justifyContent: "center" },
});
