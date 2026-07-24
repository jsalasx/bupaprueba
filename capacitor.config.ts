import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.drkapps.pruebabiometria',
  appName: 'bupaprueba',
  webDir: 'dist/bupaprueba/browser',
  plugins: {
    GoogleAuth: {
      scopes: ['profile', 'email'],
      serverClientId: '537881986178-23dhaeonqr38trcrmj76ke6hs64j8qpk.apps.googleusercontent.com', // El ID Web, NO el de Android
      forceCodeForRefreshToken: true,
    },
  },
};

export default config;
