import { environment } from '../environments/environment';

/**
 * Configuración del flujo "Sign in with Apple".
 *
 * Este backend usa REDIRECCIÓN DE SERVIDOR (form_post), NO el Apple JS SDK:
 *   1. El navegador navega a APPLE_LOGIN_URL (navegación real, no fetch).
 *   2. Apple autentica y hace POST directo al callback del backend.
 *   3. El backend crea la sesión, setea una cookie HttpOnly (SameSite=None; Secure)
 *      y redirige a la ruta de éxito o de error de Angular.
 *   4. Angular lee la sesión con GET /auth/me usando withCredentials: true.
 *
 * Config confirmada con backend (QA):
 *   - Base: comparte el mismo host/path que el resto de ms-controller.
 *   - redirectUri (return URL de Apple, lo maneja el backend):
 *       https://api-qa.bupa.cl/portal-blua/ms-controller/auth/apple/callback
 *   - successRedirectUrl: http://localhost:4200/auth/apple/success
 *   - errorRedirectUrl:   http://localhost:4200/auth/apple/error
 *     → coinciden con las rutas Angular /auth/apple/success y /auth/apple/error.
 *   - Cookie de sesión: "blua_session", HttpOnly + Secure + SameSite=None, maxAge 1800s.
 *
 * ⚠️ CORS: al ser cross-site con SameSite=None, el backend debe responder con
 *   Access-Control-Allow-Credentials: true y el origen exacto de Angular en
 *   Allow-Origin (no "*"). En QA ese origen es http://localhost:4200.
 */
// Base del flujo Apple; se configura en environment.appleApiBaseUrl (QA: https://api-qa.bupa.cl/portal-blua/ms-controller).
export const APPLE_API_BASE = environment.appleApiBaseUrl;

/** Services ID (web) y return URL registrados en Apple. El plugin nativo los exige,
 *  aunque en iOS nativo el aud del token termina siendo el Bundle ID de la app. */
export const APPLE_SERVICES_ID = 'cl.bupa.blua.qa.signin';
export const APPLE_WEB_REDIRECT_URI =
  'https://api-qa.bupa.cl/portal-blua/ms-controller/auth/apple/callback';

/** Endpoint al que el navegador NAVEGA (window.location.href), no se llama por fetch. */
export const APPLE_LOGIN_URL = `${APPLE_API_BASE}/auth/apple/login`;

/**
 * Endpoint que devuelve la sesión actual leyendo la cookie HttpOnly.
 * OJO: comparte base con los endpoints de Google/biometría, así que el interceptor
 * discrimina por esta URL exacta (no por la base) para aplicarle withCredentials.
 */
export const AUTH_ME_URL = `${APPLE_API_BASE}/auth/me`;

/**
 * Endpoint del flujo NATIVO iOS (aún no existe en backend — coordinar).
 * La app postea aquí el identityToken/authorizationCode que devuelve la hoja
 * nativa de Apple, y el backend responde con tokens (como /auth/google/exchange).
 * OJO: el aud del token nativo es el Bundle ID de la app (no el Services ID web).
 */
export const APPLE_EXCHANGE_URL = `${APPLE_API_BASE}/auth/apple/exchange`;

/** Rutas Angular a las que el backend redirige tras el callback de Apple. */
export const APPLE_SUCCESS_PATH = '/auth/apple/success';
export const APPLE_ERROR_PATH = '/auth/apple/error';
