#!/bin/sh
# Makes the key that signs the APK, once. Android only installs an update signed with the same key,
# so keep android/keystore.jks and android/keystore.properties safe. They are not committed.
set -eu
cd "$(dirname "$0")/.."
. scripts/env.sh
if [ -e keystore.jks ]; then
  echo "android/keystore.jks already exists, so nothing was changed."
  exit 0
fi
password=$(LC_ALL=C tr -dc 'A-Za-z0-9' </dev/urandom | head -c 32)
"$JAVA_HOME/bin/keytool" -genkeypair -keystore keystore.jks -alias telephoto -keyalg RSA -keysize 4096 -validity 36500 \
  -storepass "$password" -keypass "$password" -dname "CN=Tele-Photo" >/dev/null 2>&1
umask 077
cat > keystore.properties <<PROPS
storeFile=keystore.jks
storePassword=$password
keyAlias=telephoto
keyPassword=$password
PROPS
chmod 600 keystore.jks keystore.properties
echo "Made android/keystore.jks. Keep a copy of it and of android/keystore.properties somewhere safe."
