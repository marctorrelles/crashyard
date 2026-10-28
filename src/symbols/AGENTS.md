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
  `/health`, and passes the request on. One for the deployment (`idFromName('builder')`), so uploads take turns; 503
  when there's no container, as on a dev server without `CONTAINERS=1`.
- `uploads.ts`: chunks (R2 `chunks/<sha1>`, deleted once assembled; an R2 rule drops strays after a day) joined
  into one buffer sized from their heads (the file held once) and checked; files up to 48 MB (`MAX_FILE`, what sentry-cli
  is told as `maxFileSize`: the file, its copy in the Wasm module and the conversion, about three times the file, must
  fit a 128 MB isolate). With the SymCache builder (`builder.ts`), sentry-cli is told `BIG_FILE`, 512 MB, and a debug
  file over `WORKER_FILE`, 16 MB, goes to it (`storeBigDebugFile`): its chunks joined straight into R2 as a multipart
  upload (`assembleInto`, SHA-1 by `node:crypto` as the parts go; R2's parts must be one size but the last, as
  sentry-cli's chunks are), then streamed from R2 to the container twice, `/objects` and each object's `/symcache`,
  the SymCache streamed back to R2 at the length the container sends in `x-length` (a Durable Object drops
  Content-Length); the worker never holds the file. A big ProGuard mapping is refused, as lookups would hold it;
  bundles stay within 48 MB. Measured on Caliu's 107 MB arm64 dSYM: the Wasm module grew to 328 MB in Node, the
  native builder made the same 40 MB SymCache in 1.5 s. `uploads.test.ts` (a fake builder: assembled, stored,
  checksum refused, a big mapping refused, the builder's error said) and `test/big-dsym.e2e.test.ts` (opt-in). A
  debug file becomes a row per object with its
  SymCache (`symcaches/…`); a ProGuard mapping is kept as it is (its UUID from sentry-cli); an artifact bundle (zip
  with `manifest.json`) becomes a SourceMapCache per minified file and its map, found by debug id or URL (`~/path`).
- `symbolicate.ts`: on each event, before grouping, every stack: the exceptions', then each thread's, with the same
  caches. Native frames by address within their image (the crashing
  frame as is, the others one byte back: return addresses), inlined calls as frames of their own; Android frames and
  obfuscated exception classes through ProGuard; JavaScript through SourceMapCaches, with context lines. Each image's
  addresses go in one SymCache lookup, and each mapping's frames, every stack's and the classes, in one ProGuard call,
  so a mapping's mapper is built once an event (an ANR's 30 threads made it 30 times). Mapped
  frames are marked `symbolicated` so a second pass leaves them be. Debug files an event lacked go in
  `missingDebugFiles`, shown on the event; the OS's own libraries (`/usr/lib/`, `/System/`, Android's `/system/`,
  `/apex/`…) never do, as no one can upload theirs. Checked against a real sentry-cocoa 9.31 crash on macOS. What it reads is cached in the isolate for ten minutes (48 MB budget);
  an upload forgets the negative lookups of its project. SymCaches are kept in the shared module's memory instead
  (`pinSymcache`, 64 MB, first in first out, one alone may be bigger: Caliu's is 40 MB), read there straight from R2,
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
