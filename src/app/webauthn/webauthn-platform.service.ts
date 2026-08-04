/**
 * Capa de plataforma de WebAuthn: una sola interfaz, dos implementaciones.
 *
 * La lógica de ceremonia (begin → ceremonia → finish → errores) vive UNA sola
 * vez en `WebAuthnService`; lo único que cambia entre web y app nativa es quién
 * ejecuta la ceremonia:
 *
 *  - Web  → `navigator.credentials.create/get` del navegador.
 *  - App  → APIs nativas de passkeys (AuthenticationServices en iOS,
 *           Credential Manager en Android) vía plugin de Capacitor.
 *
 * POR QUÉ NO SE USA `navigator.credentials` EN LA APP:
 * el WebView de Capacitor corre sobre `capacitor://localhost` (iOS) o
 * `http://localhost` (Android). Ese origen no coincide con el RPID del portal y
 * el backend valida `Origin`, así que toda ceremonia hecha con la API del
 * WebView falla en `finish`. La ruta nativa es obligatoria, no una optimización.
 */
import { Injectable, InjectionToken, inject } from '@angular/core';
import { Capacitor } from '@capacitor/core';
import { CapacitorPasskey } from '@capgo/capacitor-passkey';
import { base64UrlToBuffer, bufferToBase64Url } from './base64url.util';
import {
  AuthenticationCredentialJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationCredentialJSON,
} from './webauthn.dto';
import { WebAuthnCeremonyError } from './webauthn-error.mapper';

/** Contrato común de las dos ramas. */
export interface WebAuthnPlatform {
  /**
   * ¿Hay un autenticador de plataforma usable (Face ID / Touch ID / huella)?
   * Se llama ANTES de mostrar cualquier UI de passkeys.
   */
  isAvailable(): Promise<boolean>;

  /** Ejecuta `create()` y devuelve la respuesta cruda serializada a JSON. */
  createCredential(
    options: PublicKeyCredentialCreationOptionsJSON,
  ): Promise<RegistrationCredentialJSON>;

  /** Ejecuta `get()` y devuelve la respuesta cruda serializada a JSON. */
  getCredential(
    options: PublicKeyCredentialRequestOptionsJSON,
  ): Promise<AuthenticationCredentialJSON>;
}

/**
 * Resuelve la rama por plataforma. Los componentes nunca eligen.
 *
 * Lleva factory propia (`providedIn: 'root'`) para que funcione sin registrar
 * nada en `app.config.ts` ni en cada TestBed; un test que necesite un doble
 * simplemente provee el token y pisa este default.
 */
export const WEBAUTHN_PLATFORM = new InjectionToken<WebAuthnPlatform>('WEBAUTHN_PLATFORM', {
  providedIn: 'root',
  factory: () =>
    Capacitor.isNativePlatform()
      ? inject(NativeWebAuthnPlatform)
      : inject(BrowserWebAuthnPlatform),
});

// ── Rama web ───────────────────────────────────────────────────────────────

@Injectable({ providedIn: 'root' })
export class BrowserWebAuthnPlatform implements WebAuthnPlatform {
  async isAvailable(): Promise<boolean> {
    if (typeof window === 'undefined' || !window.PublicKeyCredential) {
      return false;
    }

    try {
      return await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
    } catch {
      return false;
    }
  }

  async createCredential(
    options: PublicKeyCredentialCreationOptionsJSON,
  ): Promise<RegistrationCredentialJSON> {
    const credential = (await navigator.credentials.create({
      publicKey: this.toCreationOptions(options),
    })) as PublicKeyCredential | null;

    if (!credential) {
      throw new WebAuthnCeremonyError('client_cancelled');
    }

    return this.serializeRegistration(credential);
  }

  async getCredential(
    options: PublicKeyCredentialRequestOptionsJSON,
  ): Promise<AuthenticationCredentialJSON> {
    const credential = (await navigator.credentials.get({
      publicKey: this.toRequestOptions(options),
    })) as PublicKeyCredential | null;

    if (!credential) {
      throw new WebAuthnCeremonyError('client_cancelled');
    }

    return this.serializeAuthentication(credential);
  }

  // ── JSON → opciones con ArrayBuffer ──────────────────────────────────────

  /**
   * Usa `parseCreationOptionsFromJSON` si el navegador lo trae; si no, hidrata
   * a mano los campos que son `BufferSource` en la API pero string base64url en
   * el JSON del backend.
   */
  private toCreationOptions(
    options: PublicKeyCredentialCreationOptionsJSON,
  ): PublicKeyCredentialCreationOptions {
    const parse = (PublicKeyCredential as any).parseCreationOptionsFromJSON;
    if (typeof parse === 'function') {
      return parse.call(PublicKeyCredential, options);
    }

    return {
      ...options,
      challenge: base64UrlToBuffer(options.challenge),
      user: { ...options.user, id: base64UrlToBuffer(options.user.id) },
      excludeCredentials: options.excludeCredentials?.map(descriptor => ({
        ...descriptor,
        id: base64UrlToBuffer(descriptor.id),
        transports: descriptor.transports as AuthenticatorTransport[] | undefined,
      })),
    } as PublicKeyCredentialCreationOptions;
  }

  private toRequestOptions(
    options: PublicKeyCredentialRequestOptionsJSON,
  ): PublicKeyCredentialRequestOptions {
    const parse = (PublicKeyCredential as any).parseRequestOptionsFromJSON;
    if (typeof parse === 'function') {
      return parse.call(PublicKeyCredential, options);
    }

    return {
      ...options,
      challenge: base64UrlToBuffer(options.challenge),
      allowCredentials: options.allowCredentials?.map(descriptor => ({
        ...descriptor,
        id: base64UrlToBuffer(descriptor.id),
        transports: descriptor.transports as AuthenticatorTransport[] | undefined,
      })),
    } as PublicKeyCredentialRequestOptions;
  }

  // ── Credential → JSON base64url ──────────────────────────────────────────

  private serializeRegistration(credential: PublicKeyCredential): RegistrationCredentialJSON {
    const native = (credential as any).toJSON;
    if (typeof native === 'function') {
      return native.call(credential) as RegistrationCredentialJSON;
    }

    const response = credential.response as AuthenticatorAttestationResponse;

    return {
      id: credential.id,
      rawId: bufferToBase64Url(credential.rawId),
      type: credential.type as 'public-key',
      authenticatorAttachment: credential.authenticatorAttachment ?? null,
      clientExtensionResults: credential.getClientExtensionResults() as Record<string, unknown>,
      response: {
        clientDataJSON: bufferToBase64Url(response.clientDataJSON),
        attestationObject: bufferToBase64Url(response.attestationObject),
        transports:
          typeof response.getTransports === 'function' ? response.getTransports() : undefined,
      },
    };
  }

  private serializeAuthentication(
    credential: PublicKeyCredential,
  ): AuthenticationCredentialJSON {
    const native = (credential as any).toJSON;
    if (typeof native === 'function') {
      return native.call(credential) as AuthenticationCredentialJSON;
    }

    const response = credential.response as AuthenticatorAssertionResponse;

    return {
      id: credential.id,
      rawId: bufferToBase64Url(credential.rawId),
      type: credential.type as 'public-key',
      authenticatorAttachment: credential.authenticatorAttachment ?? null,
      clientExtensionResults: credential.getClientExtensionResults() as Record<string, unknown>,
      response: {
        clientDataJSON: bufferToBase64Url(response.clientDataJSON),
        authenticatorData: bufferToBase64Url(response.authenticatorData),
        signature: bufferToBase64Url(response.signature),
        userHandle: response.userHandle ? bufferToBase64Url(response.userHandle) : null,
      },
    };
  }
}

// ── Rama nativa (iOS / Android) ────────────────────────────────────────────

/**
 * Se importa el wrapper del paquete, NO `registerPlugin('CapacitorPasskey')`.
 *
 * Parece equivalente pero no lo es: el wrapper traduce `{ publicKey }` a lo que
 * espera el lado nativo, que es `{ origin, requestJson }` con las opciones ya
 * serializadas a string (`CapacitorPasskeyPlugin.java` hace
 * `call.getString("requestJson")`). Saltarse esa traducción hace que Android
 * responda `DataError: requestJson is required`.
 *
 * El `origin` se pasa SIEMPRE explícito (ver `rpOrigin`): el `resolveOrigin` del
 * wrapper prioriza `location.origin` sobre el rpId, y en el WebView de Capacitor
 * eso es `https://localhost`, que no es un origin que el backend pueda validar.
 *
 * El plugin también ofrece `shimWebAuthn()`, que parchea `navigator.credentials`
 * globalmente. No lo usamos: la llamada directa deja la rama nativa explícita.
 */
const NativePasskey = CapacitorPasskey;

@Injectable({ providedIn: 'root' })
export class NativeWebAuthnPlatform implements WebAuthnPlatform {
  async isAvailable(): Promise<boolean> {
    try {
      const { available } = await NativePasskey.isSupported();
      return available === true;
    } catch {
      // Plugin no instalado / no implementado en esta plataforma.
      return false;
    }
  }

  async createCredential(
    options: PublicKeyCredentialCreationOptionsJSON,
  ): Promise<RegistrationCredentialJSON> {
    try {
      return await NativePasskey.createCredential({
        publicKey: options,
        origin: this.rpOrigin(options.rp?.id),
      });
    } catch (error) {
      throw this.translate(error);
    }
  }

  async getCredential(
    options: PublicKeyCredentialRequestOptionsJSON,
  ): Promise<AuthenticationCredentialJSON> {
    try {
      return await NativePasskey.getCredential({
        publicKey: options,
        origin: this.rpOrigin(options.rpId),
        // `mediation` NO es opcional en la práctica, aunque el tipo lo diga:
        // el wrapper (`createNativeRequest`) usa `'mediation' in options` como
        // ÚNICO discriminante entre login y registro. Sin la clave presente
        // trata estas opciones como las de un `create()` y lee `publicKey.rp.id`,
        // que no existe en unas opciones de autenticación → TypeError en JS
        // antes de llegar al puente nativo. 'optional' es el default de WebAuthn.
        mediation: 'optional',
      });
    } catch (error) {
      throw this.translate(error);
    }
  }

  /**
   * Origin que se declara al autenticador, derivado del rpId que manda el
   * backend. Sin esto, el wrapper usa `location.origin` del WebView
   * (`https://localhost`): Android lo ignora, pero iOS 17.4+ lo codifica en el
   * `clientDataJSON` y el `finish` falla porque el backend nunca va a tener
   * `https://localhost` en `webauthn.rpOrigins`.
   */
  private rpOrigin(rpId: string | undefined): string | undefined {
    return rpId ? `https://${rpId}` : undefined;
  }

  /**
   * Normaliza al mismo juego de códigos que produce el navegador, para que el
   * mapper sea uno solo.
   *
   * El puente de Capacitor NO conserva el `name` del DOMException, pero sí
   * expone el nombre en `code` y en `data.name` (ver `Sending plugin error` en
   * logcat), así que se mira eso primero: es exacto y estable. El match por
   * mensaje queda sólo como red de seguridad para los errores que el wrapper
   * lanza en JS, antes del puente, donde no hay `code`.
   */
  private translate(error: unknown): WebAuthnCeremonyError {
    const raw = error as { code?: string; message?: string; data?: { name?: string } };
    const name = raw?.code ?? raw?.data?.name ?? '';

    switch (name) {
      // Android: NoCredentialException. iOS: no hay credencial para el rpId.
      case 'NotFoundError':
        return new WebAuthnCeremonyError('client_no_credential', error);
      case 'NotAllowedError':
        return new WebAuthnCeremonyError('client_cancelled', error);
      case 'InvalidStateError':
        return new WebAuthnCeremonyError('client_already_registered', error);
      case 'NotSupportedError':
        return new WebAuthnCeremonyError('client_unsupported', error);
      case 'SecurityError':
        return new WebAuthnCeremonyError('client_security_error', error);
      case 'AbortError':
        return new WebAuthnCeremonyError('client_cancelled', error);
    }

    const message = String(raw?.message ?? '').toLowerCase();

    if (message.includes('no matching passkey') || message.includes('no credential')) {
      return new WebAuthnCeremonyError('client_no_credential', error);
    }
    if (message.includes('cancel') || message.includes('abort')) {
      return new WebAuthnCeremonyError('client_cancelled', error);
    }
    if (message.includes('not supported') || message.includes('unavailable')) {
      return new WebAuthnCeremonyError('client_unsupported', error);
    }
    if (message.includes('already') || message.includes('duplicate')) {
      return new WebAuthnCeremonyError('client_already_registered', error);
    }
    return new WebAuthnCeremonyError('client_unknown', error);
  }
}

