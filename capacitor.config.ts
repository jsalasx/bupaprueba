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
    /**
     * `origin` = el rpId del backend (`webauthn.rpId`), con esquema.
     *
     * De aquí el hook de `cap sync` deriva el dominio y escribe el entitlement
     * `webcredentials:bupa.drkapps.com` en iOS, que es OBLIGATORIO: sin
     * Associated Domains, `ASAuthorization` no encuentra ni crea passkeys.
     *
     * En Android no hace falta para nada — el `<meta-data asset_statements>`
     * que también añade cubre la dirección app → web (App Links), mientras que
     * las passkeys usan la contraria: el `assetlinks.json` del dominio
     * delegando `get_login_creds` en el package + huella de firma.
     */
    CapacitorPasskey: {
      origin: 'https://bupa.drkapps.com',
    },
  },
};

export default config;
