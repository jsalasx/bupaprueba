/**
 * Traducción única de errores de WebAuthn a algo mostrable.
 *
 * La UI NUNCA compara strings de `message`: sólo mira `code` (el del backend) o
 * `kind` (el de la ceremonia local). Este archivo es el único sitio donde un
 * código se convierte en texto.
 */
import { HttpErrorResponse } from '@angular/common/http';
import { ApiError } from '../auth.service';

/** Qué debe hacer la UI además de mostrar el mensaje. */
export type WebAuthnRecovery =
  /** Nada especial: mostrar el mensaje y permitir reintentar. */
  | 'retry'
  /** El desafío murió: hay que volver a llamar a `begin`. */
  | 'restart'
  /** Sesión inválida: mandar a re-autenticarse. */
  | 'reauth'
  /** La lista local quedó obsoleta: recargarla. */
  | 'refresh'
  /** Bloquear el botón durante `retryAfterSeconds`. */
  | 'backoff'
  /** Feature apagada: ocultar la entrada de passkeys. */
  | 'hide'
  /** El usuario canceló: no se muestra error. */
  | 'silent';

export interface WebAuthnFailure {
  /** Código del backend, o un código sintético del cliente (`client_*`). */
  code: string;
  /** Texto listo para mostrar, en español. */
  message: string;
  recovery: WebAuthnRecovery;
  /** Sólo en 429. */
  retryAfterSeconds?: number;
}

/**
 * Códigos del contrato del backend.
 *
 * `webauthn_assertion_invalid` y `webauthn_credential_invalid` comparten un
 * mensaje deliberadamente genérico: el backend es ambiguo a propósito para no
 * filtrar si el usuario existe o si la credencial fue revocada, y el cliente no
 * debe deshacer esa ambigüedad.
 */
const BACKEND_ERRORS: Record<string, { message: string; recovery: WebAuthnRecovery }> = {
  webauthn_challenge_invalid: {
    message: 'La operación tardó demasiado. Vamos a intentarlo de nuevo.',
    recovery: 'restart',
  },
  webauthn_user_verification_required: {
    message: 'Necesitamos que confirmes con Face ID, huella o el PIN de tu dispositivo.',
    recovery: 'retry',
  },
  webauthn_invalid_name: {
    message: 'El nombre del dispositivo no puede estar vacío.',
    recovery: 'retry',
  },
  webauthn_bad_request: {
    message: 'No pudimos completar la operación. Intenta de nuevo.',
    recovery: 'retry',
  },
  webauthn_unauthorized: {
    message: 'Tu sesión expiró. Vuelve a ingresar para continuar.',
    recovery: 'reauth',
  },
  webauthn_assertion_invalid: {
    message: 'No pudimos verificar tu dispositivo.',
    recovery: 'retry',
  },
  webauthn_credential_invalid: {
    message: 'No pudimos verificar tu dispositivo.',
    recovery: 'retry',
  },
  webauthn_credential_not_found: {
    message: 'Este dispositivo ya no está registrado.',
    recovery: 'refresh',
  },
  webauthn_credential_duplicate: {
    message: 'Este dispositivo ya está registrado.',
    recovery: 'retry',
  },
  webauthn_credential_limit: {
    message:
      'Alcanzaste el máximo de dispositivos registrados. Elimina uno desde la gestión de dispositivos para agregar este.',
    recovery: 'refresh',
  },
  webauthn_rate_limited: {
    message: 'Demasiados intentos seguidos. Espera unos segundos e inténtalo de nuevo.',
    recovery: 'backoff',
  },
  SERVICE_UNAVAILABLE: {
    message: 'El acceso con passkey no está disponible por ahora.',
    recovery: 'hide',
  },
};

/** Errores que nacen en el cliente (DOMException de la API o falta de soporte). */
const CLIENT_ERRORS: Record<string, { message: string; recovery: WebAuthnRecovery }> = {
  client_cancelled: {
    // NotAllowedError = el usuario canceló o expiró el prompt del sistema.
    message: '',
    recovery: 'silent',
  },
  client_already_registered: {
    // InvalidStateError en registro: el autenticador ya tiene una credencial
    // para esta cuenta (venía en excludeCredentials).
    message: 'Este dispositivo ya está registrado.',
    recovery: 'retry',
  },
  client_unsupported: {
    message: 'Tu dispositivo no permite el acceso con passkey.',
    recovery: 'hide',
  },
  client_no_credential: {
    // NotFoundError / NoCredentialException: la cuenta tiene passkeys, pero
    // ninguna vive en ESTE dispositivo (las de `transports: ['internal']` no
    // salen del aparato donde se crearon). No es un fallo recuperable
    // reintentando: hay que registrar este dispositivo.
    message: 'No hay una passkey de esta cuenta en este dispositivo. Ingresa de otra forma y registra este dispositivo.',
    recovery: 'retry',
  },
  client_security_error: {
    message: 'No pudimos validar el dominio de la aplicación. Contacta a soporte.',
    recovery: 'retry',
  },
  client_unknown: {
    message: 'No pudimos completar la operación. Intenta de nuevo.',
    recovery: 'retry',
  },
};

/** Error de ceremonia originado en el cliente, con código estable. */
export class WebAuthnCeremonyError extends Error {
  constructor(
    readonly code: keyof typeof CLIENT_ERRORS | string,
    override readonly cause?: unknown,
  ) {
    super(code);
    this.name = 'WebAuthnCeremonyError';
  }
}

/** Traduce una `DOMException` de `navigator.credentials` a un código estable. */
export function ceremonyErrorCode(error: unknown): string {
  const name = (error as { name?: string })?.name;

  switch (name) {
    // Cancelación del usuario o timeout del prompt: NO es un error rojo.
    case 'NotAllowedError':
    case 'AbortError':
      return 'client_cancelled';
    case 'InvalidStateError':
      return 'client_already_registered';
    case 'NotSupportedError':
      return 'client_unsupported';
    case 'SecurityError':
      return 'client_security_error';
    default:
      return error instanceof WebAuthnCeremonyError ? error.code : 'client_unknown';
  }
}

/** Punto único de traducción: cualquier error → `WebAuthnFailure`. */
export function toWebAuthnFailure(error: unknown): WebAuthnFailure {
  if (error instanceof HttpErrorResponse) {
    const body = error.error as ApiError | null;
    const code = body?.code ?? '';
    const known = BACKEND_ERRORS[code];

    if (known) {
      return {
        code,
        message: known.message,
        recovery: known.recovery,
        retryAfterSeconds:
          known.recovery === 'backoff' ? retryAfterSeconds(error) : undefined,
      };
    }

    if (error.status === 0) {
      return {
        code: 'client_offline',
        message: 'No pudimos conectar con el servidor. Revisa tu conexión.',
        recovery: 'retry',
      };
    }

    if (error.status === 503) {
      return { code: 'SERVICE_UNAVAILABLE', ...BACKEND_ERRORS['SERVICE_UNAVAILABLE'] };
    }

    if (error.status === 401) {
      return { code: 'webauthn_unauthorized', ...BACKEND_ERRORS['webauthn_unauthorized'] };
    }

    return { code: code || `http_${error.status}`, ...CLIENT_ERRORS['client_unknown'] };
  }

  const code = ceremonyErrorCode(error);
  // El cliente también emite códigos del catálogo del backend sin llegar a la
  // red (p. ej. `webauthn_unauthorized` cuando no hay sesión guardada).
  const known = CLIENT_ERRORS[code] ?? BACKEND_ERRORS[code] ?? CLIENT_ERRORS['client_unknown'];
  return { code, message: known.message, recovery: known.recovery };
}

/** Segundos de espera de un 429 (header `Retry-After`), con tope defensivo. */
function retryAfterSeconds(error: HttpErrorResponse): number {
  const header = Number(error.headers?.get('Retry-After'));
  if (Number.isFinite(header) && header > 0) {
    return Math.min(header, 300);
  }
  // El backend limita a 10 ceremonias por identidad cada 60 s.
  return 60;
}
