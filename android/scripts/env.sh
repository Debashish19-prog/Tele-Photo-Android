# Android Studio keeps its own Java and SDK, and often neither is on PATH.
: "${JAVA_HOME:=$HOME/Applications/android-studio/jbr}"
: "${ANDROID_HOME:=$HOME/Android/Sdk}"
if [ ! -x "$JAVA_HOME/bin/java" ]; then
  echo "Java was not found at $JAVA_HOME. Set JAVA_HOME to Android Studio's jbr folder." >&2
  exit 1
fi
if [ ! -d "$ANDROID_HOME/platforms" ]; then
  echo "The Android SDK was not found at $ANDROID_HOME. Set ANDROID_HOME to it." >&2
  exit 1
fi
export JAVA_HOME ANDROID_HOME
