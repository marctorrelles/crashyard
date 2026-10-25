#!/bin/sh
# Builds symcache.wasm for the worker. Needs Rust (rustup, with the wasm32-wasip1 target) and wasi-sdk, for the C and
# C++ parts (zstd, and Swift's demangler): https://github.com/WebAssembly/wasi-sdk/releases, unpacked anywhere, its
# path in WASI_SDK_PATH (default: ~/.cache/wasi-sdk-*).
set -eu
cd "$(dirname "$0")"
WASI_SDK_PATH="${WASI_SDK_PATH:-$(ls -d "$HOME"/.cache/wasi-sdk-* 2>/dev/null | tail -1)}"
[ -d "$WASI_SDK_PATH" ] || { echo "wasi-sdk not found: set WASI_SDK_PATH" >&2; exit 1; }
SYSROOT="$WASI_SDK_PATH/share/wasi-sysroot"
export CC_wasm32_wasip1="$WASI_SDK_PATH/bin/clang"
export CXX_wasm32_wasip1="$WASI_SDK_PATH/bin/clang++"
export AR_wasm32_wasip1="$WASI_SDK_PATH/bin/llvm-ar"
export CFLAGS_wasm32_wasip1="--sysroot=$SYSROOT"
export CXXFLAGS_wasm32_wasip1="--sysroot=$SYSROOT -fno-exceptions -include stdlib.h"
export RUSTFLAGS="-C link-arg=-L$SYSROOT/lib/wasm32-wasip1/noeh -C link-arg=-lc++ -C link-arg=-lc++abi"
# rustup's rust-lld looks for its LLVM library beside it, and it lives in the toolchain's lib
TOOLCHAIN="$(rustc --print sysroot)"
export DYLD_FALLBACK_LIBRARY_PATH="$TOOLCHAIN/lib"
cargo build --release --target wasm32-wasip1
cp target/wasm32-wasip1/release/crashyard_symcache.wasm ../src/symbols/symcache.wasm
ls -l ../src/symbols/symcache.wasm
