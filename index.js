import { registerRootComponent } from 'expo';
import { Platform } from 'react-native';

let App;
if (Platform.OS === 'web') {
  App = require('./App.web').default;
} else {
  App = require('./App').default;
}

registerRootComponent(App);


