#!/bin/bash
# Deuz SDK docs - sunucu tarafi yeniden deploy.
# Tum dizin islemleri /opt/deuz icinde; ec2-user sahibi oldugu icin sudo gerekmez
# (sadece systemctl icin gerekir).
set -euo pipefail
export PATH=/usr/local/bin:$PATH
export NEXT_TELEMETRY_DISABLED=1
export NODE_OPTIONS="--max-old-space-size=3072"

ROOT=/opt/deuz
APP="$ROOT/current"
STAGE="$ROOT/stage"
OLD="$ROOT/old"
TARBALL=/tmp/deuz-docs.tar.gz

[ -f "$TARBALL" ] || { echo "HATA: $TARBALL yok"; exit 1; }

echo ">> staging dizinine aciliyor"
rm -rf "$STAGE"
mkdir -p "$STAGE"
tar -xzf "$TARBALL" -C "$STAGE"

# package-lock degismediyse node_modules'u tasi, npm ci'yi atla (~1 dk kazanc)
if [ -d "$APP/node_modules" ] && cmp -s "$APP/package-lock.json" "$STAGE/package-lock.json"; then
  echo ">> package-lock ayni, node_modules yeniden kullaniliyor"
  cp -al "$APP/node_modules" "$STAGE/node_modules" 2>/dev/null || cp -a "$APP/node_modules" "$STAGE/node_modules"
else
  echo ">> bagimliliklar kuruluyor"
  (cd "$STAGE" && npm ci --no-audit --no-fund)
fi

echo ">> build"
(cd "$STAGE" && npm run build)

echo ">> devreye aliniyor"
sudo systemctl stop deuz-docs
rm -rf "$OLD"
mv "$APP" "$OLD"
mv "$STAGE" "$APP"
sudo systemctl start deuz-docs

for i in $(seq 1 30); do
  code=$(curl -s -o /dev/null -w '%{http_code}' http://localhost/docs || true)
  if [ "$code" = "200" ]; then
    echo ">> saglikli (HTTP $code)"
    rm -rf "$OLD"
    exit 0
  fi
  sleep 2
done

echo ">> SAGLIK KONTROLU BASARISIZ - geri aliniyor"
sudo systemctl stop deuz-docs
rm -rf "$APP"
mv "$OLD" "$APP"
sudo systemctl start deuz-docs
exit 1
