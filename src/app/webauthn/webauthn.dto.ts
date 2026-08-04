/**
 * DTOs de FIDO2/WebAuthn — reflejan el JSON del backend TAL CUAL.
 *
 * Regla del contrato: `finish` espera la respuesta **cruda** de
 * `navigator.credentials`. No se añaden ni se quitan campos en el camino; los
 * mappers de este módulo sólo traducen base64url ↔ ArrayBuffer.
 *
 * Base path: /portal-blua/ms-controller
 */

// ── Opciones que llegan del backend (JSON, buffers en base64url) ────────────

export interface PublicKeyCredentialDescriptorJSON {
  /** base64url */
  id: string;
  type: 'public-key';
  transports?: string[];
}

export interface PublicKeyCredentialUserEntityJSON {
  /** base64url */
  id: string;
  name: string;
  displayName: string;
}

export interface PublicKeyCredentialCreationOptionsJSON {
  /** base64url */
  challenge: string;
  rp: { id?: string; name: string };
  user: PublicKeyCredentialUserEntityJSON;
  pubKeyCredParams: { type: 'public-key'; alg: number }[];
  timeout?: number;
  excludeCredentials?: PublicKeyCredentialDescriptorJSON[];
  authenticatorSelection?: {
    authenticatorAttachment?: 'platform' | 'cross-platform';
    residentKey?: 'discouraged' | 'preferred' | 'required';
    requireResidentKey?: boolean;
    /** El backend lo fija en 'required' siempre. */
    userVerification?: 'discouraged' | 'preferred' | 'required';
  };
  /** El backend envía 'none'. Tipado como union por la spec de WebAuthn. */
  attestation?: 'none' | 'indirect' | 'direct' | 'enterprise';
  extensions?: Record<string, unknown>;
}

export interface PublicKeyCredentialRequestOptionsJSON {
  /** base64url */
  challenge: string;
  timeout?: number;
  rpId?: string;
  allowCredentials?: PublicKeyCredentialDescriptorJSON[];
  userVerification?: 'discouraged' | 'preferred' | 'required';
  extensions?: Record<string, unknown>;
}

// ── begin / finish ─────────────────────────────────────────────────────────

/**
 * El backend (go-webauthn) serializa un `protocol.CredentialCreation`, que
 * envuelve las opciones en su propio campo `publicKey`. Según el ambiente y la
 * versión llega plano o anidado un nivel, así que el tipo admite ambos y
 * `unwrapOptions` lo normaliza.
 */
type MaybeWrapped<T> = T | { publicKey: T };

/** 200 de POST /auth/webauthn/register/begin */
export interface RegisterBeginResponseDto {
  ceremonyId: string;
  publicKey: MaybeWrapped<PublicKeyCredentialCreationOptionsJSON>;
}

/** 200 de POST /auth/webauthn/authenticate/begin */
export interface AuthenticateBeginResponseDto {
  ceremonyId: string;
  publicKey: MaybeWrapped<PublicKeyCredentialRequestOptionsJSON>;
}

/** Lo que el resto del cliente consume: opciones ya aplanadas. */
export interface RegisterBegin {
  ceremonyId: string;
  publicKey: PublicKeyCredentialCreationOptionsJSON;
}

export interface AuthenticateBegin {
  ceremonyId: string;
  publicKey: PublicKeyCredentialRequestOptionsJSON;
}

/**
 * Aplana el `{ publicKey: { publicKey: … } }` de go-webauthn.
 *
 * Se apoya en `challenge`, que está en TODAS las opciones de ceremonia y nunca
 * en el envoltorio: si el nivel actual no lo tiene pero sí tiene un `publicKey`
 * dentro, entonces esto es un envoltorio y hay que bajar un nivel.
 */
export function unwrapOptions<T extends { challenge?: string }>(value: MaybeWrapped<T>): T {
  const candidate = value as T & { publicKey?: T };

  if (candidate?.challenge === undefined && candidate?.publicKey) {
    return candidate.publicKey;
  }

  return candidate;
}

/** Respuesta cruda de `create()` serializada a JSON. */
export interface RegistrationCredentialJSON {
  id: string;
  /** base64url */
  rawId: string;
  type: 'public-key';
  authenticatorAttachment?: string | null;
  clientExtensionResults: Record<string, unknown>;
  response: {
    /** base64url */
    clientDataJSON: string;
    /** base64url */
    attestationObject: string;
    transports?: string[];
  };
}

/** Respuesta cruda de `get()` serializada a JSON. */
export interface AuthenticationCredentialJSON {
  id: string;
  /** base64url */
  rawId: string;
  type: 'public-key';
  authenticatorAttachment?: string | null;
  clientExtensionResults: Record<string, unknown>;
  response: {
    /** base64url */
    clientDataJSON: string;
    /** base64url */
    authenticatorData: string;
    /** base64url */
    signature: string;
    /** base64url — ausente si el autenticador no lo entrega. */
    userHandle?: string | null;
  };
}

export interface RegisterFinishRequestDto {
  ceremonyId: string;
  credential: RegistrationCredentialJSON;
}

/** 200 de POST /auth/webauthn/register/finish */
export interface RegisterFinishResponseDto {
  status: 'ok';
  /** base64url */
  credentialId: string;
}

export interface AuthenticateFinishRequestDto {
  ceremonyId: string;
  credential: AuthenticationCredentialJSON;
}

/** 200 de POST /auth/webauthn/authenticate/finish */
export interface AuthenticateFinishResponseDto {
  status: 'ok';
  accessToken: string;
  refreshToken: string;
}

// ── Gestión de dispositivos ────────────────────────────────────────────────

export interface WebAuthnCredentialDto {
  /** base64url — va en la URL, requiere encodeURIComponent. */
  credentialId: string;
  name: string;
  createdAt: string;
  lastUsedAt?: string;
  transports?: string[];
}

/** 200 de GET /auth/webauthn/credentials */
export interface WebAuthnCredentialListDto {
  credentials: WebAuthnCredentialDto[];
}

/** 200 de PATCH/DELETE /auth/webauthn/credentials/{id} */
export interface WebAuthnStatusDto {
  status: 'ok';
}

// ── Modelo de dominio ──────────────────────────────────────────────────────

/** Passkey registrada, ya normalizada para la UI. */
export interface Passkey {
  credentialId: string;
  name: string;
  createdAt: Date;
  lastUsedAt: Date | null;
  transports: string[];
}

export function toPasskey(dto: WebAuthnCredentialDto): Passkey {
  return {
    credentialId: dto.credentialId,
    name: dto.name,
    createdAt: new Date(dto.createdAt),
    lastUsedAt: dto.lastUsedAt ? new Date(dto.lastUsedAt) : null,
    transports: dto.transports ?? [],
  };
}
