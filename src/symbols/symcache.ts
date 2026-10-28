// The glue to symcache.wasm (Sentry's symbolic and proguard, built from ../../symcache): debug files in, SymCaches
// out, addresses to functions, files and lines, and Android frames retraced. The module is WASI (its C++ part, Swift's demangler, needs libc++), so it gets the
// few WASI calls it imports as stubs: it never touches files, and only writes panics to stderr.

export type DebugObject = {
  debugId: string
  codeId: string | null
  arch: string
  kind: string
  fileFormat: string
  hasDebugInfo: boolean
  hasSymbols: boolean
}

export type SymbolFrame = {
  function: string // demangled
  rawFunction: string
  symAddr: number
  file: string | null
  line: number
  language: string | null
}

type Exports = {
  memory: WebAssembly.Memory
  alloc(len: number): number
  dealloc(ptr: number, len: number): void
  objects(ptr: number, len: number): bigint
  symcache(ptr: number, len: number, idPtr: number, idLen: number): bigint
  lookup(ptr: number, len: number, addrPtr: number, addrLen: number): bigint
  proguard(ptr: number, len: number, framesPtr: number, framesLen: number): bigint
  sourcemapcache(ptr: number, len: number, mapPtr: number, mapLen: number): bigint
  sourcemap_lookup(ptr: number, len: number, posPtr: number, posLen: number): bigint
}

export type SourceLocation = {
  file: string | null
  line: number // 0-based
  column: number
  function: string | null // the enclosing function, from the minified file's scopes
  name: string | null
  pre: string[]
  context: string | null
  post: string[]
} | null

/** Bytes kept in the module's memory (`load`) */
export type Loaded = { ptr: number; len: number }

export type JavaFrame = { module: string; function: string; lineno?: number; file?: string | null }

const EBADF = 8

function wasi(memory: () => WebAssembly.Memory) {
  const view = () => new DataView(memory().buffer)
  let stderr = ''
  return {
    random_get: (ptr: number, len: number) => {
      crypto.getRandomValues(new Uint8Array(memory().buffer, ptr, len))
      return 0
    },
    environ_sizes_get: (count: number, size: number) => {
      view().setUint32(count, 0, true)
      view().setUint32(size, 0, true)
      return 0
    },
    environ_get: () => 0,
    clock_time_get: (_id: number, _precision: bigint, out: number) => {
      view().setBigUint64(out, BigInt(Date.now()) * 1_000_000n, true)
      return 0
    },
    fd_write: (fd: number, iovs: number, count: number, written: number) => {
      let total = 0
      for (let i = 0; i < count; i++) {
        const ptr = view().getUint32(iovs + i * 8, true)
        const len = view().getUint32(iovs + i * 8 + 4, true)
        if (fd === 2) stderr += new TextDecoder().decode(new Uint8Array(memory().buffer, ptr, len))
        total += len
      }
      view().setUint32(written, total, true)
      if (stderr.includes('\n')) {
        console.error(`symcache: ${stderr.trim()}`)
        stderr = ''
      }
      return 0
    },
    fd_close: () => EBADF,
    fd_seek: () => EBADF,
    fd_prestat_get: () => EBADF,
    fd_prestat_dir_name: () => EBADF,
    proc_exit: (code: number) => {
      throw new Error(`symcache exited with ${code}`)
    },
    sched_yield: () => 0,
  }
}

/** One instance of the module; its memory only grows, so make one per big job (a debug file) and drop it after */
export async function symbolic(module: WebAssembly.Module) {
  // The WASI calls read the instance's memory, which only exists once it's made
  const self: { exports?: Exports } = {}
  const instance = await WebAssembly.instantiate(module, { wasi_snapshot_preview1: wasi(() => self.exports!.memory) })
  const w = (self.exports = instance.exports as unknown as Exports)

  const put = (bytes: Uint8Array) => {
    const ptr = w.alloc(bytes.length)
    new Uint8Array(w.memory.buffer, ptr, bytes.length).set(bytes)
    return [ptr, bytes.length] as const
  }
  const take = (packed: bigint) => {
    const ptr = Number(packed >> 32n)
    const len = Number(packed & 0xffffffffn)
    const out = new Uint8Array(w.memory.buffer, ptr, len).slice()
    w.dealloc(ptr, len)
    return out
  }
  const json = <T>(bytes: Uint8Array): T => {
    const value = JSON.parse(new TextDecoder().decode(bytes))
    if (value && typeof value === 'object' && 'error' in value) throw new Error(value.error)
    return value
  }

  return {
    /** The objects in a debug file: a fat dSYM has one per architecture */
    objects(file: Uint8Array): DebugObject[] {
      const [ptr, len] = put(file)
      try {
        return json(take(w.objects(ptr, len)))
      } finally {
        w.dealloc(ptr, len)
      }
    },
    /** One object's SymCache */
    symcache(file: Uint8Array, debugId: string): Uint8Array {
      const [ptr, len] = put(file)
      const [idPtr, idLen] = put(new TextEncoder().encode(debugId))
      try {
        const out = take(w.symcache(ptr, len, idPtr, idLen))
        if (out[0] !== 0) json(out.subarray(1))
        return out.subarray(1)
      } finally {
        w.dealloc(ptr, len)
        w.dealloc(idPtr, idLen)
      }
    },
    /** A stream of `size` bytes read straight into the module's memory and kept there until `free`: a SymCache isn't
     *  held twice, once in JavaScript and once here */
    async load(size: number, stream: ReadableStream<Uint8Array>): Promise<Loaded> {
      const ptr = w.alloc(size)
      let at = 0
      try {
        for await (const chunk of stream) {
          if (at + chunk.length > size) throw new Error('longer than its size')
          // The buffer is read anew each time: another call may have grown the memory meanwhile
          new Uint8Array(w.memory.buffer, ptr + at, chunk.length).set(chunk)
          at += chunk.length
        }
        if (at !== size) throw new Error('shorter than its size')
      } catch (error) {
        w.dealloc(ptr, size)
        throw error
      }
      return { ptr, len: size }
    },
    free(loaded: Loaded) {
      w.dealloc(loaded.ptr, loaded.len)
    },
    /** Each address (relative to the image) to its frames, innermost (inlined) first; [] when not found */
    lookup(symcache: Loaded, addresses: bigint[]): SymbolFrame[][] {
      const raw = new Uint8Array(addresses.length * 8)
      const view = new DataView(raw.buffer)
      addresses.forEach((a, i) => view.setBigUint64(i * 8, a, true))
      const [aPtr, aLen] = put(raw)
      try {
        return json(take(w.lookup(symcache.ptr, symcache.len, aPtr, aLen)))
      } finally {
        w.dealloc(aPtr, aLen)
      }
    },
    /** A minified file and its source map as a SourceMapCache */
    sourcemapcache(minified: Uint8Array, map: Uint8Array): Uint8Array {
      const [ptr, len] = put(minified)
      const [mPtr, mLen] = put(map)
      try {
        const out = take(w.sourcemapcache(ptr, len, mPtr, mLen))
        if (out[0] !== 0) json(out.subarray(1))
        return out.subarray(1)
      } finally {
        w.dealloc(ptr, len)
        w.dealloc(mPtr, mLen)
      }
    },
    /** 0-based [line, column] positions in the minified file to where they came from */
    sourcemapLookup(cache: Uint8Array, positions: [number, number][]): SourceLocation[] {
      const raw = new Uint8Array(positions.length * 8)
      const view = new DataView(raw.buffer)
      positions.forEach(([line, column], i) => {
        view.setUint32(i * 8, line, true)
        view.setUint32(i * 8 + 4, column, true)
      })
      const [ptr, len] = put(cache)
      const [pPtr, pLen] = put(raw)
      try {
        return json(take(w.sourcemap_lookup(ptr, len, pPtr, pLen)))
      } finally {
        w.dealloc(ptr, len)
        w.dealloc(pPtr, pLen)
      }
    },
    /** Android frames back to the source's: each to its frames, inlined ones first; [] when the class isn't mapped */
    proguard(mapping: Uint8Array, frames: JavaFrame[]): JavaFrame[][] {
      const [ptr, len] = put(mapping)
      const [fPtr, fLen] = put(new TextEncoder().encode(JSON.stringify(frames)))
      try {
        return json(take(w.proguard(ptr, len, fPtr, fLen)))
      } finally {
        w.dealloc(ptr, len)
        w.dealloc(fPtr, fLen)
      }
    },
  }
}

export type Symbolic = Awaited<ReturnType<typeof symbolic>>
