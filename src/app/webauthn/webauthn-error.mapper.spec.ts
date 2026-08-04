import { HttpErrorResponse, HttpHeaders } from '@angular/common/http';
import {
  WebAuthnCeremonyError,
  ceremonyErrorCode,
  toWebAuthnFailure,
} from './webauthn-error.mapper';

/** Error del backend: siempre `{ code, message }`. */
const apiError = (status: number, code: string, headers?: HttpHeaders) =>
  new HttpErrorResponse({
    status,
    error: { code, message: 'mensaje crudo del backend' },
    headers,
  });

describe('toWebAuthnFailure — errores del backend', () => {
  it('400 webauthn_challenge_invalid pide reiniciar la ceremonia', () => {
    const failure = toWebAuthnFailure(apiError(400, 'webauthn_challenge_invalid'));

    expect(failure.code).toBe('webauthn_challenge_invalid');
    expect(failure.recovery).toBe('restart');
  });

  it('400 webauthn_user_verification_required pide confirmar con biometría', () => {
    const failure = toWebAuthnFailure(apiError(400, 'webauthn_user_verification_required'));

    expect(failure.recovery).toBe('retry');
    expect(failure.message).toMatch(/Face ID|huella|PIN/i);
  });

  it('401 webauthn_unauthorized manda a re-autenticarse', () => {
    expect(toWebAuthnFailure(apiError(401, 'webauthn_unauthorized')).recovery).toBe('reauth');
  });

  it('401 assertion/credential invalid usan el MISMO mensaje genérico', () => {
    const assertion = toWebAuthnFailure(apiError(401, 'webauthn_assertion_invalid'));
    const credential = toWebAuthnFailure(apiError(401, 'webauthn_credential_invalid'));

    // El backend es ambiguo a propósito: el cliente no debe deshacer esa
    // ambigüedad revelando si el usuario existe o si la credencial fue revocada.
    expect(assertion.message).toBe(credential.message);
    expect(assertion.message).toBe('No pudimos verificar tu dispositivo.');
    expect(assertion.message).not.toMatch(/usuario|revocad|existe/i);
  });

  it('404 webauthn_credential_not_found refresca la lista', () => {
    expect(toWebAuthnFailure(apiError(404, 'webauthn_credential_not_found')).recovery).toBe(
      'refresh',
    );
  });

  it('409 webauthn_credential_duplicate avisa que ya está registrado', () => {
    const failure = toWebAuthnFailure(apiError(409, 'webauthn_credential_duplicate'));

    expect(failure.message).toBe('Este dispositivo ya está registrado.');
    expect(failure.recovery).toBe('retry');
  });

  it('409 webauthn_credential_limit deriva a gestión de dispositivos', () => {
    const failure = toWebAuthnFailure(apiError(409, 'webauthn_credential_limit'));

    expect(failure.recovery).toBe('refresh');
    expect(failure.message).toMatch(/máximo/i);
  });

  it('429 webauthn_rate_limited pide backoff y respeta Retry-After', () => {
    const headers = new HttpHeaders({ 'Retry-After': '30' });
    const failure = toWebAuthnFailure(apiError(429, 'webauthn_rate_limited', headers));

    expect(failure.recovery).toBe('backoff');
    expect(failure.retryAfterSeconds).toBe(30);
  });

  it('429 sin Retry-After cae en los 60 s de la ventana del backend', () => {
    expect(toWebAuthnFailure(apiError(429, 'webauthn_rate_limited')).retryAfterSeconds).toBe(60);
  });

  it('503 SERVICE_UNAVAILABLE oculta la feature', () => {
    expect(toWebAuthnFailure(apiError(503, 'SERVICE_UNAVAILABLE')).recovery).toBe('hide');
    // Aunque el body venga sin código, el status manda.
    expect(toWebAuthnFailure(new HttpErrorResponse({ status: 503 })).recovery).toBe('hide');
  });

  it('status 0 se reporta como problema de conexión', () => {
    const failure = toWebAuthnFailure(new HttpErrorResponse({ status: 0 }));

    expect(failure.code).toBe('client_offline');
    expect(failure.recovery).toBe('retry');
  });

  it('un code desconocido no rompe: cae en el mensaje genérico', () => {
    const failure = toWebAuthnFailure(apiError(400, 'algo_que_no_existe'));

    expect(failure.code).toBe('algo_que_no_existe');
    expect(failure.recovery).toBe('retry');
  });
});

describe('ceremonyErrorCode — errores del autenticador', () => {
  const domError = (name: string) => Object.assign(new Error(name), { name });

  it('NotAllowedError es cancelación del usuario o timeout', () => {
    expect(ceremonyErrorCode(domError('NotAllowedError'))).toBe('client_cancelled');
    expect(ceremonyErrorCode(domError('AbortError'))).toBe('client_cancelled');
  });

  it('InvalidStateError en registro = credencial ya existente', () => {
    expect(ceremonyErrorCode(domError('InvalidStateError'))).toBe('client_already_registered');
  });

  it('NotSupportedError y SecurityError tienen código propio', () => {
    expect(ceremonyErrorCode(domError('NotSupportedError'))).toBe('client_unsupported');
    expect(ceremonyErrorCode(domError('SecurityError'))).toBe('client_security_error');
  });

  it('respeta el código de un WebAuthnCeremonyError', () => {
    expect(ceremonyErrorCode(new WebAuthnCeremonyError('client_cancelled'))).toBe(
      'client_cancelled',
    );
  });

  it('cualquier otra cosa es desconocido', () => {
    expect(ceremonyErrorCode(new Error('boom'))).toBe('client_unknown');
    expect(ceremonyErrorCode(null)).toBe('client_unknown');
  });
});

describe('toWebAuthnFailure — errores del autenticador', () => {
  it('la cancelación es silenciosa: sin mensaje que mostrar', () => {
    const failure = toWebAuthnFailure(Object.assign(new Error(), { name: 'NotAllowedError' }));

    expect(failure.recovery).toBe('silent');
    expect(failure.message).toBe('');
  });

  it('InvalidStateError se muestra como duplicado, no como error crudo', () => {
    const failure = toWebAuthnFailure(Object.assign(new Error(), { name: 'InvalidStateError' }));

    expect(failure.message).toBe('Este dispositivo ya está registrado.');
  });

  it('el WebAuthnCeremonyError de sesión ausente deriva a re-autenticación', () => {
    // Lo emite el servicio sin llegar a la red cuando no hay accessToken; debe
    // terminar en el mismo tratamiento que un 401 del backend.
    const failure = toWebAuthnFailure(new WebAuthnCeremonyError('webauthn_unauthorized'));

    expect(failure.recovery).toBe('reauth');
  });
});
