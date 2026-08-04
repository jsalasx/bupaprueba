#!/usr/bin/env bash
#
# Verifica de punta a punta la configuración de dominio de las passkeys.
#
#   ./scripts/verify-passkeys.sh [dominio] [package] [ruta-al-apk]
#
# Comprueba, en este orden:
#   1. Fingerprint SHA-256 del APK y su apk-key-hash (lo que va en rpOrigins).
#   2. assetlinks.json publicado, con content-type correcto y el fingerprint dentro.
#   3. El veredicto de la API oficial de Digital Asset Links de Google.
#   4. apple-app-site-association publicado (iOS).
#
# Lo único que NO puede comprobar es el `rpOrigins` del backend, que no es
# público: compara a mano el apk-key-hash del paso 1 con tu YAML.
set -uo pipefail

DOMAIN="${1:-bupa.drkapps.com}"
PACKAGE="${2:-com.drkapps.pruebabiometria}"
APK="${3:-android/app/build/outputs/apk/debug/app-debug.apk}"

ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; }
bad()  { printf '  \033[31m✗\033[0m %s\n' "$1"; FAILED=1; }
head_() { printf '\n\033[1m%s\033[0m\n' "$1"; }
FAILED=0

# ── 1. Firma del APK ────────────────────────────────────────────────────────
head_ "1. Firma del APK"
APKSIGNER=$(ls -d "$HOME"/Library/Android/sdk/build-tools/*/apksigner 2>/dev/null | tail -1)
ADB="$HOME/Library/Android/sdk/platform-tools/adb"

# Si no hay APK compilado, se baja el instalado en el dispositivo: es el que
# Android valida de verdad, así que como fuente de verdad es incluso mejor.
if [[ ! -f "$APK" && -x "$ADB" ]] && "$ADB" get-state >/dev/null 2>&1; then
  REMOTE=$("$ADB" shell pm path "$PACKAGE" 2>/dev/null | head -1 | tr -d '\r' | sed 's/package://')
  if [[ -n "$REMOTE" ]]; then
    APK=$(mktemp -t installed).apk
    "$ADB" pull "$REMOTE" "$APK" >/dev/null 2>&1 \
      && echo "  (usando el APK instalado en el dispositivo)"
  fi
fi

if [[ -z "$APKSIGNER" || ! -f "$APK" ]]; then
  bad "No encuentro apksigner ni un APK. Compila con: cd android && ./gradlew assembleDebug"
  HEX=""
else
  HEX=$(JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home" \
        "$APKSIGNER" verify --print-certs "$APK" 2>/dev/null \
        | grep -i "certificate SHA-256 digest" | awk '{print $NF}')
  if [[ -z "$HEX" ]]; then
    bad "No pude leer el certificado de $APK"
  else
    # Formato con ':' para assetlinks.json, y base64url para rpOrigins.
    FINGERPRINT=$(echo "$HEX" | tr 'a-z' 'A-Z' | sed 's/../&:/g;s/:$//')
    KEYHASH=$(echo "$HEX" | xxd -r -p | openssl base64 -A | tr '+/' '-_' | tr -d '=')
    ok "SHA-256:      $FINGERPRINT"
    ok "apk-key-hash: android:apk-key-hash:$KEYHASH"
    echo "     ↑ este valor debe estar en webauthn.rpOrigins del backend"
  fi
fi

# ── 2. assetlinks.json ──────────────────────────────────────────────────────
head_ "2. assetlinks.json en https://$DOMAIN"
AL=$(curl -sS -i --max-time 15 "https://$DOMAIN/.well-known/assetlinks.json" 2>/dev/null)

if grep -qi "^HTTP/.* 200" <<<"$AL"; then
  ok "HTTP 200"
else
  bad "No responde 200: $(head -1 <<<"$AL")"
fi

if grep -qi "^content-type: *application/json" <<<"$AL"; then
  ok "Content-Type: application/json"
else
  bad "Content-Type incorrecto — Play Services descarta el archivo sin avisar"
fi

BODY=$(sed -n '/^\r*$/,$p' <<<"$AL")
grep -q "get_login_creds" <<<"$BODY" \
  && ok "relation delegate_permission/common.get_login_creds" \
  || bad "Falta la relation get_login_creds (la de passkeys)"

grep -q "$PACKAGE" <<<"$BODY" \
  && ok "package_name $PACKAGE" \
  || bad "El package $PACKAGE no aparece en el archivo"

if [[ -n "${FINGERPRINT:-}" ]]; then
  grep -qi "$FINGERPRINT" <<<"$BODY" \
    && ok "El fingerprint del APK está en la lista" \
    || bad "El fingerprint del APK NO está en assetlinks.json"
fi

# ── 3. Veredicto de Google ──────────────────────────────────────────────────
head_ "3. API de Digital Asset Links de Google"
if [[ -n "${FINGERPRINT:-}" ]]; then
  RES=$(curl -sS --max-time 25 -G "https://digitalassetlinks.googleapis.com/v1/assetlinks:check" \
    --data-urlencode "source.web.site=https://$DOMAIN" \
    --data-urlencode "relation=delegate_permission/common.get_login_creds" \
    --data-urlencode "target.androidApp.packageName=$PACKAGE" \
    --data-urlencode "target.androidApp.certificate.sha256Fingerprint=$FINGERPRINT" 2>/dev/null)
  grep -q '"linked": *true' <<<"$RES" \
    && ok "linked: true — Google valida la asociación" \
    || bad "Google NO valida la asociación: $(tr -d '\n' <<<"$RES" | cut -c1-200)"
else
  bad "Sin fingerprint no puedo consultar"
fi

# ── 4. Apple ────────────────────────────────────────────────────────────────
head_ "4. apple-app-site-association (iOS)"
AASA=$(curl -sS -i --max-time 15 "https://$DOMAIN/.well-known/apple-app-site-association" 2>/dev/null)

if grep -qi "^HTTP/.* 200" <<<"$AASA"; then
  ok "HTTP 200"
  grep -qi "^content-type: *application/json" <<<"$AASA" \
    && ok "Content-Type: application/json" \
    || bad "Content-Type incorrecto — iOS lo rechaza"
  grep -q "webcredentials" <<<"$AASA" \
    && ok "Sección webcredentials presente" \
    || bad "Falta la sección webcredentials (es la de passkeys)"
else
  bad "No publicado: $(head -1 <<<"$AASA")"
fi

# ── Resumen ─────────────────────────────────────────────────────────────────
if [[ $FAILED -eq 0 ]]; then
  printf '\n\033[32mTodo correcto.\033[0m\n'
else
  printf '\n\033[31mHay comprobaciones fallidas (ver ✗ arriba).\033[0m\n'
fi
exit $FAILED
