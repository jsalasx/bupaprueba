/**
 * Token de reCAPTCHA para los endpoints públicos.
 *
 * `POST /auth/webauthn/authenticate/begin` exige el header `X-Forms-Captcha`
 * porque es público (sin sesión). Hoy este proyecto NO tiene reCAPTCHA montado:
 * ningún otro endpoint público lo pide, así que no hay "mecanismo existente" al
 * que engancharse.
 *
 * Este servicio deja el punto de integración aislado y resuelto por
 * configuración, sin bloquear el resto del flujo:
 *
 *  - `environment.recaptchaSiteKey` presente → carga reCAPTCHA v3 y pide un
 *    token real por ejecución (`grecaptcha.execute`).
 *  - Ausente → devuelve `environment.captchaTestToken` (pruebas locales contra
 *    un backend con la validación relajada).
 *
 * Cuando el portal integre reCAPTCHA de verdad, basta con poner la site key en
 * el environment: no hay que tocar el store ni los componentes.
 */
import { Injectable } from '@angular/core';
import { environment } from '../../environments/environment';

/** API global que inyecta el script de reCAPTCHA v3. */
declare const grecaptcha: {
  ready(cb: () => void): void;
  execute(siteKey: string, options: { action: string }): Promise<string>;
};

const SCRIPT_ID = 'recaptcha-v3';

@Injectable({ providedIn: 'root' })
export class CaptchaService {
  private loader: Promise<void> | null = null;

  /**
   * Token para el header `X-Forms-Captcha`.
   * @param action Acción de reCAPTCHA v3, para que el backend puntúe por contexto.
   */
  async getToken(action: string): Promise<string> {
    const siteKey = environment.recaptchaSiteKey;

    if (!siteKey) {
      return environment.captchaTestToken;
    }

    await this.loadScript(siteKey);

    return new Promise<string>((resolve, reject) => {
      grecaptcha.ready(() => {
        grecaptcha.execute(siteKey, { action }).then(resolve, reject);
      });
    });
  }

  /** Inyecta el script una sola vez y reutiliza la promesa en llamadas siguientes. */
  private loadScript(siteKey: string): Promise<void> {
    if (this.loader) {
      return this.loader;
    }

    this.loader = new Promise<void>((resolve, reject) => {
      if (document.getElementById(SCRIPT_ID)) {
        resolve();
        return;
      }

      const script = document.createElement('script');
      script.id = SCRIPT_ID;
      script.src = `https://www.google.com/recaptcha/api.js?render=${siteKey}`;
      script.async = true;
      script.onload = () => resolve();
      script.onerror = () => {
        this.loader = null;
        reject(new Error('No se pudo cargar reCAPTCHA.'));
      };

      document.head.appendChild(script);
    });

    return this.loader;
  }
}
