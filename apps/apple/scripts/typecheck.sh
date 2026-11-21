#!/usr/bin/env bash
# Compiler-only fallback when local Xcode's simulator services cannot load.
# This does not replace a full Xcode build or real-device validation.
set -euo pipefail
APPLE_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TASK_BUILD_DIR="$(mktemp -d "${TMPDIR:-/tmp}/emperor-apple-typecheck.XXXXXX")"
trap 'rm -rf "$TASK_BUILD_DIR"' EXIT
SWIFTC="$(xcrun --find swiftc)"
for target in iphone watch; do
    if [[ "$target" == iphone ]]; then
        sdk=iphonesimulator
        triple=arm64-apple-ios17.0-simulator
        app=iPhone
    else
        sdk=watchsimulator
        triple=arm64-apple-watchos10.0-simulator
        app=Watch
    fi
    sdk_path="$(xcrun --sdk "$sdk" --show-sdk-path)"
    mkdir -p "$TASK_BUILD_DIR/$target"
    "$SWIFTC" -module-cache-path "$TASK_BUILD_DIR/cache" -sdk "$sdk_path" -target "$triple" -swift-version 5 \
        -parse-as-library -emit-module -module-name EmperorCore -emit-module-path "$TASK_BUILD_DIR/$target/EmperorCore.swiftmodule" \
        "$APPLE_ROOT"/Sources/EmperorCore/*.swift
    "$SWIFTC" -Xfrontend -disable-sandbox -module-cache-path "$TASK_BUILD_DIR/cache" -sdk "$sdk_path" -target "$triple" -swift-version 5 \
        -parse-as-library -typecheck -I "$TASK_BUILD_DIR/$target" "$APPLE_ROOT"/Shared/*.swift "$APPLE_ROOT"/"$app"/*.swift
    "$SWIFTC" -Xfrontend -disable-sandbox -module-cache-path "$TASK_BUILD_DIR/cache" -sdk "$sdk_path" -target "$triple" -swift-version 5 \
        -parse-as-library -typecheck -I "$TASK_BUILD_DIR/$target" "$APPLE_ROOT"/Widgets/*.swift
    echo "$app app and widget Swift typecheck passed"
done
