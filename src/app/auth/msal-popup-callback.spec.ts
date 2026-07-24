import { isMsalPopupCallback } from './msal-popup-callback';

const stateFor = (interactionType: string) =>
  btoa(JSON.stringify({ id: '019f913b-2b8e-7e60', meta: { interactionType } }));

/** El `state` real capturado del popup de una cuenta Microsoft. */
const REAL_POPUP_STATE =
  'eyJpZCI6IjAxOWY5MTNiLTJiOGUtN2U2MC1iNTRjLTQzZjUzNDBjNzRlYSIsIm1ldGEiOnsiaW50ZXJhY3Rpb25UeXBlIjoicG9wdXAifX0=';

const loc = (hash: string, search = ''): Location =>
  ({ hash, search }) as Location;

/** Por defecto: sin opener y sin iframe, que es como llegó el popup real. */
const win = (opts: { opener?: unknown; inIframe?: boolean } = {}): Window => {
  const self = {} as Window;
  return {
    opener: opts.opener ?? null,
    self,
    top: opts.inIframe ? ({} as Window) : self,
  } as unknown as Window;
};

describe('isMsalPopupCallback', () => {
  it('detecta el callback del popup aunque window.opener sea null', () => {
    // Caso real: tras rebotar por login.microsoftonline.com el opener se pierde,
    // y arrancar Angular aquí borraba el hash y dejaba el popup colgado.
    const location = loc(`#code=M.C521_BL2&client_info=eyJ2ZXIiOiIxLjAifQ&state=${REAL_POPUP_STATE}`);

    expect(isMsalPopupCallback(location, win())).toBe(true);
  });

  it('deja arrancar la app en el callback de redirect', () => {
    const location = loc(`#code=abc&state=${stateFor('redirect')}`);

    expect(isMsalPopupCallback(location, win())).toBe(false);
  });

  it('deja arrancar la app en una navegación normal', () => {
    expect(isMsalPopupCallback(loc(''), win())).toBe(false);
    expect(isMsalPopupCallback(loc('#/home'), win())).toBe(false);
  });

  it('detecta también un error devuelto al popup', () => {
    const location = loc(`#error=access_denied&state=${stateFor('popup')}`);

    expect(isMsalPopupCallback(location, win())).toBe(true);
  });

  it('sin state legible, se apoya en opener o iframe', () => {
    const opaque = loc('#code=abc&state=no-es-base64-json');

    expect(isMsalPopupCallback(opaque, win())).toBe(false);
    expect(isMsalPopupCallback(opaque, win({ opener: {} }))).toBe(true);
    expect(isMsalPopupCallback(opaque, win({ inIframe: true }))).toBe(true);
  });

  it('sobrevive a un state base64 cuyo + se volvió espacio', () => {
    // URLSearchParams decodifica '+' como espacio; sin normalizar, atob explota.
    const state = btoa(JSON.stringify({ meta: { interactionType: 'popup' }, p: '>>>?' }));
    expect(state).toContain('+');

    const location = loc(`#code=abc&state=${state}`);

    expect(isMsalPopupCallback(location, win())).toBe(true);
  });

  it('acepta la respuesta si llegara por query en vez de fragmento', () => {
    const location = loc('', `?code=abc&state=${stateFor('popup')}`);

    expect(isMsalPopupCallback(location, win())).toBe(true);
  });
});
