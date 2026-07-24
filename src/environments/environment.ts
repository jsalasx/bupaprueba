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
  apiBaseUrl: 'https://92fc-2800-bf0-3804-fe9-8c96-2c7a-464e-2445.ngrok-free.app/portal-blua/ms-controller',

  /** Sign in with Apple. */
  appleApiBaseUrl: 'https://api-qa.bupa.cl/portal-blua/ms-controller',
};
