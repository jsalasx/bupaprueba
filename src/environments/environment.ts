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

  /**
   * Google, Azure, OTP, biometría y chat clínico.
   *
   * Apunta al backend LOCAL: los endpoints de tickets y panel (013 y 015) todavía
   * no están desplegados en QA, así que contra api-qa.bupa.cl darían 404. Para
   * volver a QA basta con cambiar esta línea por la de `qaApiBaseUrl`.
   */
  apiBaseUrl: 'http://localhost:8080/portal-blua/ms-controller',

  /** Base de QA, conservada para volver sin buscar la URL. */
  qaApiBaseUrl: 'http://localhost:8080/portal-blua/ms-controller',

  /**
   * Sign in with Apple. Sigue en QA: el flujo de Apple usa un redirect registrado
   * en ese host, y apuntarlo a localhost rompería el callback.
   */
  appleApiBaseUrl: 'https://api-qa.bupa.cl/portal-blua/ms-controller',

  /**
   * Site key de reCAPTCHA v3 para el header `X-Forms-Captcha` del login con
   * passkey. Vacía = se usa `captchaTestToken` (ver CaptchaService).
   */
  recaptchaSiteKey: '',

  /** Token de relleno mientras no hay reCAPTCHA. Solo pruebas locales. */
  captchaTestToken: 'test-captcha-token',
};
