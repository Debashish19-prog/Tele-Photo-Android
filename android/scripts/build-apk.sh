#!/bin/sh
# Builds the website, then the APK. `build-apk.sh demo` makes a build with pretend Telegram, for testing.
set -eu
root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$root/android"
. scripts/env.sh
cd "$root"
if [ "${1:-}" = "demo" ]; then
  VITE_STORAGE=fake pnpm --filter ./web exec vite build
  cd android
  ./gradlew --no-daemon --no-configuration-cache -PdemoBuild=true :app:assembleDebug
  mkdir -p dist
  cp app/build/outputs/apk/debug/app-debug.apk dist/Tele-Photo-demo.apk
  echo "Built android/dist/Tele-Photo-demo.apk"
else
  if [ ! -e android/keystore.jks ]; then sh android/scripts/make-keystore.sh; fi
  pnpm --filter ./web build
  cd android
  ./gradlew --no-daemon --no-configuration-cache :app:assembleRelease
  mkdir -p dist
  cp app/build/outputs/apk/release/app-release.apk dist/Tele-Photo.apk
  echo "Built android/dist/Tele-Photo.apk"
fi
