// The compiled module as the worker imports it (a WebAssembly.Module, compiled once at deploy), and its instances:
// one shared by the isolate's lookups, a fresh one for each uploaded file (its memory grows with the file and is
// dropped with it). Tests compile the file themselves and don't import this.
import { type Symbolic, symbolic } from './symcache'
import wasm from './symcache.wasm'

let shared: Promise<Symbolic> | undefined
export const sharedSymbolic = () => (shared ??= symbolic(wasm))
export const freshSymbolic = () => symbolic(wasm)
