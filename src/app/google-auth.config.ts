/**
 * Client IDs de Google. Hacen falta TRES bajo el mismo proyecto de Google Cloud:
 *   - Web     → botón GSI y `serverClientId` del plugin de Android.
 *   - iOS     → flujo OAuth con PKCE en SFSafariViewController.
 *   - Android → solo autoriza la firma (package + SHA-1); no se referencia aquí.
 *
 * El `idToken` que recibe el backend se emite siempre con el client WEB, tanto
 * en web como en Android.
 */

/** Cliente Web — usado en el navegador con Google Identity Services. */
export const GOOGLE_WEB_CLIENT_ID =
  '537881986178-23dhaeonqr38trcrmj76ke6hs64j8qpk.apps.googleusercontent.com';

/** Cliente iOS — Google Cloud Console → Credenciales → Tipo: iOS → Bundle ID: com.drkapps.pruebabiometria */
export const GOOGLE_IOS_CLIENT_ID =
  '537881986178-eugpuu3m6hsh5i94lfmieljjqs4lngvu.apps.googleusercontent.com';

/**
 * Redirect del flujo PKCE en iOS: el scheme invertido del client iOS.
 * Está declarado en `ios/App/App/Info.plist` → `CFBundleURLSchemes`.
 */
export const REDIRECT_URI = `com.googleusercontent.apps.${GOOGLE_IOS_CLIENT_ID.split('.')[0]}:/`;
