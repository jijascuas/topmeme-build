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
  Alert
} from 'react-native';
import { WebView } from 'react-native-webview';
import * as IAP from 'react-native-iap';

const WEB_URL = 'https://topmeme-jijascuas.web.app/';

// Product IDs from Play Console
const PROMOTION_SKU = 'promotion_10usd';
const DONATION_SKUS = ['donate_1', 'donate_5', 'donate_10'];
const ALL_SKUS = [PROMOTION_SKU, ...DONATION_SKUS];

const App = () => {
  const webViewRef = useRef(null);
  const [canGoBack, setCanGoBack] = useState(false);

  // --- IAP Setup ---
  useEffect(() => {
    let purchaseUpdateSubscription;
    let purchaseErrorSubscription;

    const initIAP = async () => {
      try {
        await IAP.initConnection();
        if (Platform.OS === 'android') {
          // Flush any pending/failed purchases from previous sessions
          await IAP.flushFailedPurchasesCachedAsPendingAndroid();
        }
        // Fetch active products from Play Store
        await IAP.getProducts({ skus: ALL_SKUS });
      } catch (err) {
        console.warn('IAP Store Init Error:', err);
      }
    };

    initIAP();

    // Listener for successful purchases
    purchaseUpdateSubscription = IAP.purchaseUpdatedListener(async (purchase) => {
      const receipt = purchase.transactionReceipt;
      if (receipt) {
        try {
          // Send success signal back to the WebView
          webViewRef.current?.postMessage(JSON.stringify({
            type: 'PURCHASE_SUCCESS',
            productId: purchase.productId,
            transactionReceipt: receipt,
            docId: purchase.obfuscatedAccountIdAndroid || ''
          }));

          // Finalize consumption so the user can buy it again (for promotions/donations)
          await IAP.finishTransaction({ purchase, isConsumable: true });
        } catch (err) {
          console.error('IAP Finish Error:', err);
        }
      }
    });

    // Listener for errors or cancellations
    purchaseErrorSubscription = IAP.purchaseErrorListener((error) => {
      // Don't alert on "User canceled", let the WebView handle it silently or with a toast
      if (error?.code !== 'E_USER_CANCELLED') {
        console.warn('IAP Error Listener:', error);
      }
      
      webViewRef.current?.postMessage(JSON.stringify({
        type: 'PURCHASE_ERROR',
        message: error.message,
        code: error.code
      }));
    });

    return () => {
      if (purchaseUpdateSubscription) purchaseUpdateSubscription.remove();
      if (purchaseErrorSubscription) purchaseErrorSubscription.remove();
      IAP.endConnection();
    };
  }, []);

  const handlePurchase = async (sku, docId = '') => {
    try {
      if (Platform.OS === 'android') {
        // Trigger the Google Play Billing flow
        await IAP.requestPurchase({
          sku: sku,
          andDangerouslyFinishTransactionAutomaticallyIOS: false,
          obfuscatedAccountIdAndroid: docId // Store docId to link promotion to specific meme
        });
      }
    } catch (err) {
      if (err?.code !== 'E_USER_CANCELLED') {
        Alert.alert('Store Unavailable', 'Could not open the payment window. Check your connection.');
      }
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
      } else if (data.type === 'PURCHASE') {
        handlePurchase(data.productId, data.docId);
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
        // Additional WebView config
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
