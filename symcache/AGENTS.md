# symcache

Sentry's `symbolic` (and its `proguard` crate), built to WebAssembly for the worker: `src/symbols/symcache.wasm`.
The built file is committed, so deploying needs no Rust; rebuild it after changing anything here, and commit both.

```sh
./build.sh   # Rust (rustup) with the wasm32-wasip1 target, and wasi-sdk in WASI_SDK_PATH (default ~/.cache/wasi-sdk-*)
```

- `src/lib.rs`: a plain C ABI (no wasm-bindgen): `alloc`/`dealloc`, and functions that take bytes and return
  `ptr << 32 | len`. `objects`, `symcache`, `lookup` (native), `sourcemapcache`, `sourcemap_lookup` (JavaScript, with
  the enclosing function's name from the minified file's scopes), `proguard` (Android, inlined frames included).
  Errors come back as JSON `{ "error" }`.
- WASI, not `wasm32-unknown-unknown`: Swift's demangler is C++, and needs wasi-sdk's libc++ (built without
  exceptions: `-fno-exceptions`, the `noeh` libraries). Its few WASI imports are stubbed in `src/symbols/symcache.ts`.
- `-include stdlib.h`: the vendored Swift demangler uses `malloc` without including it.
- On macOS, rustup's `rust-lld` looks for `libLLVM.dylib` beside itself; `build.sh` points it at the toolchain's.
- Proven 2026-10-25 on pocketband's 16 MB dSYM: a 5.9 MB SymCache in about 200 ms and 44 MB of memory; lookups
  match `atos`, Swift names demangled.
- Licences: symbolic and proguard are MIT and BSD-3-Clause; Swift's demangler is Apache-2.0 with the runtime
  library exception.
