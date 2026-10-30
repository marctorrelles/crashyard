# Symbols

Readable stacks: what sentry-cli and the build plugins upload, and mapping each event's frames back to the source
before it's grouped. Sentry's own way, with Sentry's own code (`symbolic`, as WebAssembly: see `symcache/`).

- `symcache.ts`: the glue to `symcache.wasm`, with stubs for the WASI calls it imports. `symbolic(module)` makes an
  instance; its memory only grows, so uploads use a fresh one each (`freshSymbolic`) and lookups share one per
  isolate (`sharedSymbolic`, in `module.ts`, the only file that imports the `.wasm`; tests compile it themselves).
  `load` reads a stream straight into the module's memory (`Loaded`, kept until `free`), and `lookup` reads a loaded
  SymCache, so one is never held twice.
- `builder.ts`: `SymcacheBuilder`, the Durable Object in front of the SymCache builder's container
  (`symcache/Dockerfile`), exported by `src/server.ts` and bound as `SYMCACHE_BUILDER` only where
  `wrangler.local.json` adds the container: it starts it (stopped a minute after its last request), waits for
  `/health`, and passes the request on. Started again on every try while not running: when Cloudflare has no instance
  to place it on ("there is no container instance that can be provided to this Durable Object, try again later") a
  start just doesn't happen, so one start then polling `/health` for 30 s failed whole iOS archives (Caliu builds 196
  and 198); `@cloudflare/containers` retries the same way. One for the deployment (`idFromName('builder')`), so uploads take turns; 503
  when there's no container, as on a dev server without `CONTAINERS=1`.
- `uploads.ts`: chunks (R2 `chunks/<sha1>`, deleted once assembled; an R2 rule drops strays after a day) joined
  into one buffer sized from their heads (the file held once) and checked; files up to 48 MB (`MAX_FILE`, what sentry-cli
  is told as `maxFileSize`: the file, its copy in the Wasm module and the conversion, about three times the file, must
  fit a 128 MB isolate). With the SymCache builder (`builder.ts`), sentry-cli is told `BIG_FILE`, 512 MB, and a debug
  file over `WORKER_FILE`, 16 MB, goes to it (`storeBigDebugFile`): its chunks joined straight into R2 as a multipart
  upload (`assembleInto`, SHA-1 by `node:crypto` as the parts go; R2's parts must be one size but the last, as
  sentry-cli's chunks are), then streamed from R2 to the container twice, `/objects` and each object's `/symcache`,
  the SymCache streamed back to R2 at the length the container sends in `x-length` (a Durable Object drops
  Content-Length); the worker never holds the file. Bundles stay within 48 MB. A ProGuard mapping becomes a
  ProguardCache (the proguard crate's, read in place as a SymCache is, about 45% of the mapping), stored where a
  SymCache goes: made in the worker up to `PROGUARD_WORKER`, 8 MB (making one takes about 4.4 times the mapping in
  Wasm), past it by the builder's `/proguardcache` (from memory in `storeDebugFile`, from R2 in `storeBigDebugFile`),
  and refused without a builder; a cache over `MAX_PROGUARD_CACHE`, 64 MB, is refused, as a lookup holds it. Measured
  2026-10-29 on Caliu's 112 MB R8 mapping: a 48 MB cache in 0.85 s natively, read in 50 MB of Wasm, a lookup in 3 ms
  (building the old `ProguardMapper` took 561 MB and 0.5 s). Measured on Caliu's 107 MB arm64 dSYM: the Wasm module grew to 328 MB in Node, the
  native builder made the same 40 MB SymCache in 1.5 s. `uploads.test.ts` (a fake builder: assembled, stored,
  checksum refused, a big mapping's cache stored, one too big to read refused, the builder's error said) and `test/big-dsym.e2e.test.ts` (opt-in). A
  debug file becomes a row per object with its
  SymCache (`symcaches/…`); a ProGuard mapping one row (its UUID from sentry-cli) with its ProguardCache; an artifact bundle (zip
  with `manifest.json`) becomes a SourceMapCache per minified file and its map, found by debug id or URL (`~/path`),
  all packed into one object (`smcaches/<checksum>`, each file's `cache_offset`/`cache_length` read back as a range):
  a put each queued behind the Worker's six connections and held a 226-file server bundle's assemble ~34 s. Rows
  from before 0035 have no offset and read their whole `smcaches/<checksum>/<file>`.
- `symbolicate.ts`: on each event, before grouping, every stack: the exceptions', then each thread's, with the same
  caches. Native frames by address within their image (the crashing
  frame as is, the others one byte back: return addresses), inlined calls as frames of their own; Android frames and
  obfuscated exception classes through the mapping's ProguardCache, pinned as SymCaches are (a row without one is
  missing); JavaScript through SourceMapCaches, with context lines. Each image's
  addresses go in one SymCache lookup, and each mapping's frames, every stack's and the classes, in one ProGuard call. Mapped
  frames are marked `symbolicated` so a second pass leaves them be. Debug files an event lacked go in
  `missingDebugFiles`, shown on the event; the OS's own libraries (`/usr/lib/`, `/System/`, Android's `/system/`,
  `/apex/`…) never do, as no one can upload theirs. Checked against a real sentry-cocoa 9.31 crash on macOS. What it reads is cached in the isolate for ten minutes (48 MB budget);
  an upload forgets the negative lookups of its project. SymCaches are kept in the shared module's memory instead
  (`pinSymcache`, 64 MB, first in first out, one alone may be bigger: Caliu's is 40 MB), and ProguardCaches with them, read there straight from R2,
  never stale as their key names the file's checksum; a lookup pins those it uses until it's done, so a load for
  another event between its awaits can't free them.
- `reprocess.ts`: after an upload, the project's events of the last 30 days that named its debug ids (one JSON value,
  a bundle has hundreds; failures logged, as it runs after the answer) are mapped
  again, grouped as ingest groups them (`groupingFor` in `src/ingest/store.ts`: the project's grouping rules, then its
  grouping version, each event's `fingerprint` and `grouping_version` rewritten), and their issues regrouped (the new
  fingerprint, or a merge into the issue that already has it). `reprocess.test.ts` keeps a rule's fingerprint.

`test/uploads.e2e.test.ts` runs the real sentry-cli against the dev server with the fixtures in `test/fixtures`
(a tiny dSYM, a minified bundle, a ProGuard mapping).

CPU: making a SymCache takes about 200 ms for a 16 MB dSYM. Workers Free allows 10 ms of CPU a request, so uploads
need Workers Paid; lookups are a few ms.
