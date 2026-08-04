/**
 * Conversión base64url ↔ ArrayBuffer para WebAuthn.
 *
 * El backend entrega las opciones de la ceremonia en JSON, donde todo lo que en
 * la API del navegador es `BufferSource` viaja como string **base64url**
 * (alfabeto `-` y `_`, sin `=` de padding). Antes de llamar a
 * `navigator.credentials` hay que rehidratar esos campos a ArrayBuffer, y al
 * enviar la respuesta hay que volver a codificarlos.
 *
 * Estas funciones son deliberadamente tolerantes al decodificar (aceptan
 * base64 estándar y padding) y estrictas al codificar (siempre base64url sin
 * padding, que es lo que el backend espera).
 */

/** Decodifica base64url (o base64 estándar) a ArrayBuffer. */
export function base64UrlToBuffer(value: string): ArrayBuffer {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/');

  // atob exige longitud múltiplo de 4; el backend manda sin padding.
  const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '=');

  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }

  return bytes.buffer;
}

/** Codifica un ArrayBuffer a base64url sin padding. */
export function bufferToBase64Url(buffer: ArrayBuffer | ArrayBufferView): string {
  const bytes =
    buffer instanceof ArrayBuffer
      ? new Uint8Array(buffer)
      : new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);

  // Se procesa por bloques: String.fromCharCode(...bytes) revienta la pila con
  // attestationObject grandes (el spread mete un argumento por byte).
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }

  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** `true` si el string es base64url válido (alfabeto y longitud). */
export function isBase64Url(value: string): boolean {
  if (value.length === 0) {
    return false;
  }
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    return false;
  }
  // 1 carácter suelto no representa ningún byte completo.
  return value.length % 4 !== 1;
}
