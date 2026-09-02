import { Injectable } from '@angular/core';
import {
  HttpInterceptor,
  HttpRequest,
  HttpHandler,
  HttpEvent,
} from '@angular/common/http';
import { Observable } from 'rxjs';
import { AUTH_ME_URL } from './apple-auth.config';

@Injectable()
export class BearerTokenInterceptor implements HttpInterceptor {
  /**
   * Correo de la sesión, leído de localStorage en cada petición.
   *
   * Se lee aquí y no se inyecta AuthService a propósito: el servicio depende de
   * HttpClient, e inyectarlo en su propio interceptor cierra un ciclo que Angular
   * rechaza al arrancar.
   */
  private get sessionEmail(): string | null {
    return localStorage.getItem('user_email');
  }

  /**
   * ¿La petición va al backend local, sin puerta de enlace delante?
   *
   * Solo entonces el cliente suple el header de identidad. Contra QA o producción
   * NUNCA se envía: allí lo inyecta Kong tras validar el JWT, y uno enviado por el
   * cliente sería una suplantación.
   */
  private isLocalBackend(url: string): boolean {
    return url.startsWith('http://localhost:') || url.startsWith('http://127.0.0.1:');
  }

  private readonly PUBLIC_TOKEN =
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJhdWQiOiJwdWJsaWMiLCJleHAiOjE3ODM1MzQ2NzQsImlhdCI6MTc4MzUyNTY3NCwiaXNzIjoicHVibGljIiwianRpIjoiNGY5Y2UyMGEtZWQxMy00YyIsInB1YmxpY0tleSI6IjRmOWNlMjBhLWVkMTMtNGMiLCJyb2xlcyI6IldfcmtoWlA3dG84Mk5mcGlaVExhSGc9PSIsInNpdGUiOiJwdWJsaWMiLCJzdWIiOiIwMDAwMDAwMDAwMDAwMDAwYzZkMTliNTQxMzliNGE1NGUzNzkxMjg4ZmYxNTYzYTEiLCJ1c2VybmFtZSI6IjJENnpjYzcxTnZBT1dvVlVKMkZpVTBTcTR0TT0ifQ.NjhyKDMuwUXz7trjnbIHk33Kv7Vnj9VwdqoufJ2hFq8';

  intercept(
    req: HttpRequest<any>,
    next: HttpHandler,
  ): Observable<HttpEvent<any>> {
    // ngrok free devuelve una página HTML de advertencia si falta este header;
    // con él, deja pasar la petición al backend real. (Temporal, solo pruebas.)
    const setHeaders: Record<string, string> = {};
    if (req.url.includes('ngrok')) {
      setHeaders['ngrok-skip-browser-warning'] = 'true';
    }

    // Flujo Apple (form_post): la sesión viaja en una cookie HttpOnly cross-site.
    // /auth/me comparte base con los endpoints de Google/biometría, así que se
    // discrimina por la URL exacta: se apoya en la cookie (withCredentials) y
    // NO lleva el bearer público de Bupa (nada de headers manuales de sesión).
    // En Android no hay cookie: la variante /auth/me?token=… se autentica con el
    // token del deep link y entra por esta misma rama (withCredentials es inocuo).
    if (req.url.startsWith(AUTH_ME_URL)) {
      return next.handle(req.clone({ withCredentials: true, setHeaders }));
    }

    // El bearer público es solo el DEFAULT para endpoints anónimos. Si el
    // servicio ya puso su propio Authorization (p. ej. el accessToken del usuario
    // en /auth/biometric/register), pisarlo aquí rompería la petición.
    if (!req.headers.has('Authorization')) {
      setHeaders['Authorization'] = `Bearer ${this.PUBLIC_TOKEN}`;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // SOLO PRUEBAS LOCALES. En el despliegue real, Kong valida el JWT y es ÉL
    // quien inyecta X-User-Id; un valor enviado por el cliente se descarta. Al
    // correr el backend suelto en localhost no hay puerta de enlace, así que sin
    // esto todos los endpoints de chat responderían 401 "missing user identifier".
    //
    // La condición mira la URL y no una bandera de entorno porque es la URL la que
    // determina si hay o no puerta de enlace delante. Que esto no viaje a QA no
    // puede depender de acordarse de cambiar un flag.
    // ─────────────────────────────────────────────────────────────────────────
    if (this.isLocalBackend(req.url) && !req.headers.has('X-User-Id')) {
      const email = this.sessionEmail;
      if (email) {
        setHeaders['X-User-Id'] = email;
      }
    }

    return next.handle(req.clone({ setHeaders }));
  }
}
