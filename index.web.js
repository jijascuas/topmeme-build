import { registerRootComponent } from 'expo';
import App from './App.web';

// Sanity check
console.log('Topmeme Web: Bootstrapping App...');

registerRootComponent(App);
