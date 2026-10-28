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
- `src/bin/builder.rs` (feature `builder`, with `tiny_http`): the same `list_objects` and `make_symcache`, native,
  over HTTP on 8080 (`/health`, `/objects`, `/symcache?id=`, the SymCache's length in `x-length`) for the SymCache
  builder's container (`src/symbols/builder.ts`). `Dockerfile` builds it on Debian; wrangler builds the image on
  deploy for linux/amd64 (under emulation on Apple silicon, a few minutes the first time). `cargo build --release
--features builder --bin builder` runs it locally. Caliu's 107 MB dSYM: 1.5 s natively, 2.4 s in the amd64 image
  under emulation, the same SymCache byte for byte.
- Licences: symbolic and proguard are MIT and BSD-3-Clause, tiny_http MIT or Apache-2.0; Swift's demangler is Apache-2.0 with the runtime
  library exception.
