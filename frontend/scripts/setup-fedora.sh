#!/usr/bin/env bash
#
# Android build environment for Geodesic Notes, on Fedora.
#
# Installs the exact SDK pieces this project pins, and nothing else. Safe to
# re-run: every step checks before acting.
#
#   ./scripts/setup-fedora.sh
#   source ~/.bashrc      # or open a new shell
#
set -euo pipefail

# Pinned by expo-modules-autolinking (ExpoRootProjectPlugin.kt) for SDK 54.
# Do not "upgrade" these casually: the NDK version in particular must match or
# every native module rebuilds from source.
COMPILE_SDK=35
BUILD_TOOLS=35.0.0
NDK=27.1.12297006

SDK_ROOT="${ANDROID_HOME:-$HOME/Android/Sdk}"
CMDLINE_ZIP=commandlinetools-linux-11076708_latest.zip

say() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }

# --- JDK -------------------------------------------------------------------
# React Native 0.81 + AGP 8.x want JDK 17. Fedora ships 21 as default, which
# also works, but 17 is the version Expo tests against.
say "JDK 17"
if ! rpm -q java-17-openjdk-devel >/dev/null 2>&1; then
  sudo dnf install -y java-17-openjdk-devel
else
  echo "already installed"
fi
JAVA17=$(dirname "$(dirname "$(readlink -f "$(rpm -ql java-17-openjdk-devel | grep -m1 'bin/javac$')")")")

# --- Build tooling ---------------------------------------------------------
say "Build tooling"
# Gradle downloads its own distribution via the wrapper, so it is not installed
# here. android-tools provides adb; unzip and which are needed by sdkmanager.
sudo dnf install -y unzip which android-tools nodejs npm

# 32-bit deps: some Android SDK binaries are still 32-bit ELF.
sudo dnf install -y libstdc++.i686 zlib.i686 ncurses-libs.i686 || \
  echo "note: 32-bit libs unavailable; only matters for older build-tools"

# --- SDK command line tools ------------------------------------------------
say "Android SDK -> $SDK_ROOT"
if [ ! -x "$SDK_ROOT/cmdline-tools/latest/bin/sdkmanager" ]; then
  mkdir -p "$SDK_ROOT/cmdline-tools"
  tmp=$(mktemp -d)
  curl -fL "https://dl.google.com/android/repository/$CMDLINE_ZIP" -o "$tmp/tools.zip"
  unzip -q "$tmp/tools.zip" -d "$tmp"
  rm -rf "$SDK_ROOT/cmdline-tools/latest"
  mv "$tmp/cmdline-tools" "$SDK_ROOT/cmdline-tools/latest"
  rm -rf "$tmp"
else
  echo "cmdline-tools already present"
fi

export ANDROID_HOME="$SDK_ROOT"
export JAVA_HOME="$JAVA17"
export PATH="$SDK_ROOT/cmdline-tools/latest/bin:$SDK_ROOT/platform-tools:$PATH"

say "SDK packages"
yes | sdkmanager --licenses >/dev/null
sdkmanager --install \
  "platform-tools" \
  "platforms;android-$COMPILE_SDK" \
  "build-tools;$BUILD_TOOLS" \
  "ndk;$NDK" \
  "cmake;3.22.1"

# --- Shell environment -----------------------------------------------------
say "Shell environment"
RC="$HOME/.bashrc"
if ! grep -q 'ANDROID_HOME' "$RC" 2>/dev/null; then
  cat >> "$RC" <<EOF

# Android SDK (added by Geodesic Notes scripts/setup-fedora.sh)
export JAVA_HOME=$JAVA17
export ANDROID_HOME=$SDK_ROOT
export PATH=\$ANDROID_HOME/cmdline-tools/latest/bin:\$ANDROID_HOME/platform-tools:\$PATH
EOF
  echo "appended to $RC"
else
  echo "$RC already configures ANDROID_HOME; left alone"
fi

# --- Device access ---------------------------------------------------------
# Without this rule adb sees the phone as "no permissions" for a non-root user.
say "USB device rules"
RULES=/etc/udev/rules.d/51-android.rules
if [ ! -f "$RULES" ]; then
  echo 'SUBSYSTEM=="usb", ATTR{idVendor}=="04e8", MODE="0666", GROUP="plugdev"' | \
    sudo tee "$RULES" >/dev/null   # 04e8 = Samsung; add your vendor id if different
  sudo udevadm control --reload-rules && sudo udevadm trigger
  echo "wrote $RULES (Samsung vendor id; run 'lsusb' and add yours if needed)"
else
  echo "$RULES exists; left alone"
fi

say "Done"
cat <<EOF

  java   : $("$JAVA17/bin/java" -version 2>&1 | head -1)
  sdk    : $SDK_ROOT
  api    : $COMPILE_SDK, build-tools $BUILD_TOOLS, ndk $NDK

Open a new shell, then:

  cd frontend
  npm install
  npx expo prebuild --platform android --clean
  cd android && ./gradlew assembleDebug

First Gradle run downloads ~1 GB and takes a while. Later builds are minutes.
EOF
