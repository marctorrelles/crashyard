# Symbols

Readable stacks: what sentry-cli and the build plugins upload, and mapping each event's frames back to the source
before it's grouped. Sentry's own way, with Sentry's own code (`symbolic`, as WebAssembly: see `symcache/`).

- `symcache.ts`: the glue to `symcache.wasm`, with stubs for the WASI calls it imports. `symbolic(module)` makes an
  instance; its memory only grows, so uploads use a fresh one each (`freshSymbolic`) and lookups share one per
  isolate (`sharedSymbolic`, in `module.ts`, the only file that imports the `.wasm`; tests compile it themselves).
- `uploads.ts`: chunks (R2 `chunks/<sha1>`, deleted once assembled; an R2 rule drops strays after a day) joined
  and checked; a debug file becomes a row per object with its
  SymCache (`symcaches/…`); a ProGuard mapping is kept as it is (its UUID from sentry-cli); an artifact bundle (zip
  with `manifest.json`) becomes a SourceMapCache per minified file and its map, found by debug id or URL (`~/path`).
- `symbolicate.ts`: on each event, before grouping, every stack: the exceptions', then each thread's, with the same
  caches. Native frames by address within their image (the crashing
  frame as is, the others one byte back: return addresses), inlined calls as frames of their own; Android frames and
  obfuscated exception classes through ProGuard; JavaScript through SourceMapCaches, with context lines. Mapped
  frames are marked `symbolicated` so a second pass leaves them be. Debug files an event lacked go in
  `missingDebugFiles`, shown on the event; the OS's own libraries (`/usr/lib/`, `/System/`, Android's `/system/`,
  `/apex/`…) never do, as no one can upload theirs. Checked against a real sentry-cocoa 9.31 crash on macOS. What it reads is cached in the isolate for ten minutes (48 MB budget);
  an upload forgets the negative lookups of its project.
- `reprocess.ts`: after an upload, the project's events of the last 30 days that named its debug ids (one JSON value,
  a bundle has hundreds; failures logged, as it runs after the answer) are mapped
  again, grouped as ingest groups them (`groupingFor` in `src/ingest/store.ts`: the project's grouping rules, then its
  grouping version, each event's `fingerprint` and `grouping_version` rewritten), and their issues regrouped (the new
  fingerprint, or a merge into the issue that already has it). `reprocess.test.ts` keeps a rule's fingerprint.

`test/uploads.e2e.test.ts` runs the real sentry-cli against the dev server with the fixtures in `test/fixtures`
(a tiny dSYM, a minified bundle, a ProGuard mapping).

CPU: making a SymCache takes about 200 ms for a 16 MB dSYM. Workers Free allows 10 ms of CPU a request, so uploads
need Workers Paid; lookups are a few ms.
