/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { isElectronDesktop, isEnterpriseWeb } from '@renderer/utils/platform';

const SERVICE_WORKER_URL = './sw.js';
const LOCALHOST_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

function isPwaRegistrationSupported(): boolean {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') {
    return false;
  }

  if (isElectronDesktop() || !('serviceWorker' in navigator)) {
    return false;
  }

  const { protocol, hostname } = window.location;
  const isHttpOrigin = protocol === 'http:' || protocol === 'https:';
  if (!isHttpOrigin) {
    return false;
  }

  return window.isSecureContext || LOCALHOST_HOSTS.has(hostname);
}

export async function registerPwa(): Promise<ServiceWorkerRegistration | undefined> {
  if (isEnterpriseWeb()) {
    // Employee pages require a fresh authenticated server response and have no
    // offline mode. Retire only our old WebUI cache and worker on this origin.
    if ('caches' in window) {
      const names = await caches.keys().catch((): string[] => []);
      const webuiNames = names.filter((name) => name.startsWith('aionui-webui-'));
      if (webuiNames.length && 'serviceWorker' in navigator) {
        const registrations = await navigator.serviceWorker.getRegistrations()
          .catch((): ServiceWorkerRegistration[] => []);
        const scriptUrl = new URL(SERVICE_WORKER_URL, window.location.href).href;
        await Promise.all(registrations.filter((registration) => registration.active?.scriptURL === scriptUrl)
          .map((registration) => registration.unregister()));
      }
      await Promise.all(webuiNames.map((name) => caches.delete(name)));
    }
    return undefined;
  }
  if (!isPwaRegistrationSupported()) {
    return undefined;
  }

  try {
    const registration = await navigator.serviceWorker.register(SERVICE_WORKER_URL, { scope: './' });
    // Poll for updates on every page load so a fixed SW (e.g. v2 replacing
    // a poisoned v1 cache) reaches users without waiting for the browser's
    // own 24h update heuristic.
    registration.update().catch((): undefined => undefined);
    return registration;
  } catch (error) {
    console.warn('[PWA] Failed to register service worker:', error);
    return undefined;
  }
}

export default registerPwa;
