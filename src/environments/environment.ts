/**
 * Variables de entorno de la aplicación.
 *
 * - `apiBaseUrl`: base de los flujos de login con Google, Azure y biométrico
 *   (comparten el mismo host/path de ms-controller).
 * - `appleApiBaseUrl`: base del flujo "Sign in with Apple", que apunta a un
 *   backend distinto (QA de Bupa).
 *
 * Los endpoints se concatenan a estas bases (ej. `${apiBaseUrl}/auth/google`),
 * así que las bases NO deben terminar en barra.
 */
export const environment = {
  production: false,

  /** Google, Azure y biometría. */
  apiBaseUrl: 'https://api-qa.bupa.cl/portal-blua/ms-controller',

  /** Sign in with Apple. */
  appleApiBaseUrl: 'https://api-qa.bupa.cl/portal-blua/ms-controller',

  /**
   * Site key de reCAPTCHA v3 para el header `X-Forms-Captcha` del login con
   * passkey. Vacía = se usa `captchaTestToken` (ver CaptchaService).
   */
  recaptchaSiteKey: '',

  /** Token de relleno mientras no hay reCAPTCHA. Solo pruebas locales. */
  captchaTestToken: 'test-captcha-token',
};
