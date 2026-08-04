import { base64UrlToBuffer, bufferToBase64Url, isBase64Url } from './base64url.util';

/** Bytes → string legible, para comparar sin depender de TextDecoder. */
const toText = (buffer: ArrayBuffer) => String.fromCharCode(...new Uint8Array(buffer));
const toBytes = (text: string) => Uint8Array.from(text, c => c.charCodeAt(0)).buffer;

describe('base64url ↔ ArrayBuffer', () => {
  describe('bufferToBase64Url', () => {
    it('codifica sin padding', () => {
      // "Ma" → "TWE=" en base64 estándar; base64url va sin "=".
      expect(bufferToBase64Url(toBytes('Ma'))).toBe('TWE');
      // "M" → "TQ==" (dos signos de padding).
      expect(bufferToBase64Url(toBytes('M'))).toBe('TQ');
      // "Man" es múltiplo de 3: no lleva padding en ninguno de los dos alfabetos.
      expect(bufferToBase64Url(toBytes('Man'))).toBe('TWFu');
    });

    it('usa el alfabeto url-safe: "-" y "_" en vez de "+" y "/"', () => {
      // 0xFB 0xFF 0xBF → "+/+/" en base64 estándar.
      const bytes = new Uint8Array([0xfb, 0xff, 0xbf]);
      expect(bufferToBase64Url(bytes.buffer)).toBe('-_-_');
    });

    it('acepta un ArrayBufferView además de un ArrayBuffer', () => {
      const view = new Uint8Array(toBytes('xxMan')).subarray(2);
      expect(bufferToBase64Url(view)).toBe('TWFu');
    });

    it('codifica el vacío como string vacío', () => {
      expect(bufferToBase64Url(new ArrayBuffer(0))).toBe('');
    });

    it('no desborda la pila con buffers grandes (attestationObject real)', () => {
      const big = new Uint8Array(200_000).fill(0x41);
      expect(() => bufferToBase64Url(big.buffer)).not.toThrow();
      expect(bufferToBase64Url(big.buffer).length).toBeGreaterThan(200_000);
    });
  });

  describe('base64UrlToBuffer', () => {
    it('decodifica sin padding', () => {
      expect(toText(base64UrlToBuffer('TWFu'))).toBe('Man');
      expect(toText(base64UrlToBuffer('TWE'))).toBe('Ma');
      expect(toText(base64UrlToBuffer('TQ'))).toBe('M');
    });

    it('tolera padding explícito y base64 estándar', () => {
      // El contrato dice base64url, pero un backend descuidado podría mandar
      // cualquiera de estas variantes: decodificar debe ser permisivo.
      expect(toText(base64UrlToBuffer('TWE='))).toBe('Ma');
      expect(toText(base64UrlToBuffer('TQ=='))).toBe('M');
      expect(Array.from(new Uint8Array(base64UrlToBuffer('+/+/')))).toEqual([0xfb, 0xff, 0xbf]);
    });

    it('interpreta "-" y "_" como los caracteres url-safe', () => {
      expect(Array.from(new Uint8Array(base64UrlToBuffer('-_-_')))).toEqual([0xfb, 0xff, 0xbf]);
    });

    it('es ida y vuelta exacta para bytes binarios arbitrarios', () => {
      const original = new Uint8Array(256).map((_, i) => i);
      const round = new Uint8Array(base64UrlToBuffer(bufferToBase64Url(original.buffer)));
      expect(Array.from(round)).toEqual(Array.from(original));
    });

    it('decodifica un challenge de 32 bytes al mismo largo', () => {
      const challenge = crypto.getRandomValues(new Uint8Array(32));
      const encoded = bufferToBase64Url(challenge.buffer);

      expect(encoded).not.toContain('=');
      expect(base64UrlToBuffer(encoded).byteLength).toBe(32);
    });
  });

  describe('isBase64Url', () => {
    it('acepta base64url válido', () => {
      expect(isBase64Url('TWFu')).toBe(true);
      expect(isBase64Url('-_-_')).toBe(true);
      expect(isBase64Url('TWE')).toBe(true);
    });

    it('rechaza padding, alfabeto estándar y vacío', () => {
      expect(isBase64Url('TWE=')).toBe(false);
      expect(isBase64Url('+/+/')).toBe(false);
      expect(isBase64Url('')).toBe(false);
    });

    it('rechaza longitudes imposibles (1 carácter suelto)', () => {
      expect(isBase64Url('T')).toBe(false);
      expect(isBase64Url('TWFuT')).toBe(false);
    });
  });
});
