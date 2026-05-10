/**
 * Vue application entry point
 */

import { createPinia } from 'pinia';
import { createApp } from 'vue';

import App from './App.vue';
import './assets/styles/main.css';
import { logger } from './utils/logger';

// Create Vue app
const app = createApp(App);

// Install Pinia for state management
const pinia = createPinia();
app.use(pinia);

// Global error handler for uncaught errors
app.config.errorHandler = (err, instance, info) => {
  logger.error('Uncaught Vue error', {
    error: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? err.stack : undefined,
    info,
    component: instance?.$options?.name || 'Unknown',
  });
};

// Global warning handler (development only)
app.config.warnHandler = (msg, instance, trace) => {
  logger.warn('Vue warning', {
    message: msg,
    component: instance?.$options?.name || 'Unknown',
    trace,
  });
};

// Mount the app
app.mount('#app');

// Log startup
logger.info('Philibert renderer started');
