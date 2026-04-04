import React, { useRef, useState, useEffect } from 'react';
import {
  SafeAreaView,
  StyleSheet,
  StatusBar,
  BackHandler,
  Share,
  Platform,
  ActivityIndicator,
  View,
  Linking
} from 'react-native';
import { WebView } from 'react-native-webview';

const WEB_URL = 'https://topmeme-jijascuas.web.app/';

const App = () => {
  const webViewRef = useRef(null);
  const [canGoBack, setCanGoBack] = useState(false);

  // Generic handler to open external links safely outside the app
  const handleOpenLink = async (url) => {
    try {
      const supported = await Linking.canOpenURL(url);
      if (supported) {
        await Linking.openURL(url);
      }
    } catch (err) {
      console.warn('Error opening external link:', err);
    }
  };

  // Handle Android Back Button
  useEffect(() => {
    if (Platform.OS === 'android') {
      const backAction = () => {
        if (canGoBack && webViewRef.current) {
          webViewRef.current.goBack();
          return true; // prevent default behavior (closing the app)
        }
        return false; // allow default behavior
      };

      const backHandler = BackHandler.addEventListener(
        'hardwareBackPress',
        backAction
      );

      return () => backHandler.remove();
    }
  }, [canGoBack]);

  const onMessage = (event) => {
    try {
      const data = JSON.parse(event.nativeEvent.data);
      
      if (data.type === 'SHARE') {
        Share.share({
          message: data.message,
          title: data.title || 'Topmeme',
          url: data.url
        });
      } 
      // Handle discrete support links (Kofi, Stripe, etc)
      else if (data.type === 'OPEN_LINK' || data.type === 'PURCHASE') {
        if (data.url) {
          handleOpenLink(data.url);
        }
      }
    } catch (e) {
      console.log("Error processing message:", e);
    }
  };

  return (
    <SafeAreaView style={styles.container}>
      <StatusBar barStyle="dark-content" backgroundColor="#ffffff" />
      <WebView
        ref={webViewRef}
        source={{ uri: WEB_URL }}
        onNavigationStateChange={(navState) => {
          setCanGoBack(navState.canGoBack);
        }}
        onMessage={onMessage}
        startInLoadingState={true}
        injectedJavaScriptBeforeContentLoaded={`window.IS_TOPMEME_APK = true; true;`}
        userAgent={"Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36 TopmemeAndroidWebView"}
        renderLoading={() => (
          <View style={styles.loaderContainer}>
            <ActivityIndicator size="large" color="#3897f0" />
          </View>
        )}
        domStorageEnabled={true}
        javaScriptEnabled={true}
        allowsBackForwardNavigationGestures={true}
      />
    </SafeAreaView>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#ffffff',
  },
  loaderContainer: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#ffffff',
  },
});

export default App;
