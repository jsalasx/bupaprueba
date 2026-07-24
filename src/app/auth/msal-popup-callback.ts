/**
 * MSAL resuelve el popup (y sus iframes de token silencioso) leyendo el hash de
 * esa ventana desde la ventana que lo abrió. Si la app Angular arranca ahí dentro,
 * navega y borra el hash antes de que el padre alcance a leerlo: el login nunca
 * se resuelve y el popup queda abierto para siempre.
 *
 * Por eso el callback del popup no debe arrancar la app. `window.opener` no basta
 * para detectarlo (llega null tras el rebote por login.microsoftonline.com), así
 * que se usa la señal autoritativa: MSAL codifica el tipo de interacción dentro
 * del parámetro `state`.
 */
export function isMsalPopupCallback(location: Location, win: Window): boolean {
  // La respuesta llega en el fragmento; se mira también la query por si acaso.
  const raw = location.hash.slice(1) || location.search.slice(1);
  if (!raw) return false;

  const params = new URLSearchParams(raw);
  const hasAuthResponse =
    params.has('code') ||
    params.has('id_token') ||
    params.has('access_token') ||
    params.has('error');

  if (!hasAuthResponse) return false;

  const state = params.get('state');
  if (state) {
    try {
      // p.ej. {"id":"…","meta":{"interactionType":"popup"}} en base64.
      // URLSearchParams convierte '+' en espacio: hay que devolverlo antes de atob.
      const encoded = state.split('|')[0].replace(/ /g, '+');
      const interactionType = JSON.parse(atob(encoded))?.meta?.interactionType;

      if (interactionType === 'popup') return true;
      // Un `state` legible que dice "redirect" es concluyente: sí hay que arrancar.
      if (interactionType === 'redirect') return false;
    } catch {
      // `state` opaco o no-JSON: se cae al heurístico de abajo.
    }
  }

  return (!!win.opener && win.opener !== win) || win.self !== win.top;
}
