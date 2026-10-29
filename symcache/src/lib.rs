//! Sentry's `symbolic`, for crashyard's worker, as WebAssembly with a plain C ABI (no wasm-bindgen): the worker
//! copies bytes in with `alloc`, calls a function, and reads the result it returns as `ptr << 32 | len`.
//!
//! - `objects(file)`: the objects in a debug file (a fat dSYM holds one per architecture), as JSON.
//! - `symcache(file, debug_id)`: the SymCache for one object, Sentry's compact lookup table.
//! - `lookup(symcache, addresses)`: each address (relative to the image) to its frames, innermost (inlined) first.
//!
//! - `sourcemapcache(minified, map)`: a minified file and its source map as a SourceMapCache, which also knows each
//!   position's enclosing function (its scope), as Sentry names JavaScript frames.
//! - `sourcemap_lookup(cache, positions)`: 0-based line and column to the original file, line, column and function.
//! - `proguardcache(mapping)`: a ProGuard mapping as a ProguardCache, read in place as a SymCache is.
//! - `proguard(cache, frames)`: Android frames (class, method, line) back to the source's, inlined ones included.
//!
//! Errors come back as JSON `{"error": "..."}`; a cache comes back as raw bytes prefixed by one byte, 0 for ok.

use std::str::FromStr;

use symbolic::common::{ByteView, DebugId, Language, Name, NameMangling};
use symbolic::debuginfo::Archive;
use symbolic_demangle::{Demangle, DemangleOptions};
use symbolic::symcache::{SymCache, SymCacheConverter};

/// Memory for the caller to write its input into
#[unsafe(no_mangle)]
pub extern "C" fn alloc(len: usize) -> *mut u8 {
    let mut buffer = Vec::<u8>::with_capacity(len);
    let ptr = buffer.as_mut_ptr();
    std::mem::forget(buffer);
    ptr
}

/// Frees what `alloc` gave, or a result
#[unsafe(no_mangle)]
pub extern "C" fn dealloc(ptr: *mut u8, len: usize) {
    unsafe { drop(Vec::from_raw_parts(ptr, 0, len)) }
}

fn give(mut bytes: Vec<u8>) -> u64 {
    bytes.shrink_to_fit();
    let (ptr, len) = (bytes.as_mut_ptr() as u64, bytes.len() as u64);
    std::mem::forget(bytes);
    (ptr << 32) | len
}

unsafe fn input<'a>(ptr: *const u8, len: usize) -> &'a [u8] {
    unsafe { std::slice::from_raw_parts(ptr, len) }
}

fn error(message: impl std::fmt::Display) -> Vec<u8> {
    serde_json::json!({ "error": message.to_string() }).to_string().into_bytes()
}

pub fn list_objects(file: &[u8]) -> Result<serde_json::Value, String> {
    let archive = Archive::parse(file).map_err(|e| e.to_string())?;
    let mut objects = Vec::new();
    for object in archive.objects() {
        let object = object.map_err(|e| e.to_string())?;
        objects.push(serde_json::json!({
            "debugId": object.debug_id().to_string(),
            "codeId": object.code_id().map(|c| c.to_string()),
            "arch": object.arch().name(),
            "kind": object.kind().name(),
            "fileFormat": object.file_format().name(),
            "hasDebugInfo": object.has_debug_info(),
            "hasSymbols": object.has_symbols(),
        }));
    }
    Ok(serde_json::Value::Array(objects))
}

pub fn make_symcache(file: &[u8], debug_id: &str) -> Result<Vec<u8>, String> {
    let wanted = DebugId::from_str(debug_id).map_err(|e| e.to_string())?;
    let archive = Archive::parse(file).map_err(|e| e.to_string())?;
    for object in archive.objects() {
        let object = object.map_err(|e| e.to_string())?;
        if object.debug_id() != wanted {
            continue;
        }
        let mut converter = SymCacheConverter::new();
        converter.process_object(&object).map_err(|e| e.to_string())?;
        let mut out = Vec::new();
        converter.serialize(&mut std::io::Cursor::new(&mut out)).map_err(|e| e.to_string())?;
        return Ok(out);
    }
    Err(format!("no object {debug_id} in this file"))
}

fn demangled(name: &Name<'_>) -> String {
    name.demangle(DemangleOptions::name_only().parameters(true))
        .unwrap_or_else(|| name.as_str().to_string())
}

pub fn lookup_addresses(symcache: &[u8], addresses: &[u64]) -> Result<serde_json::Value, String> {
    let view = ByteView::from_slice(symcache);
    let cache = SymCache::parse(&view).map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for &address in addresses {
        let frames: Vec<_> = cache
            .lookup(address)
            .map(|location| {
                let function = location.function();
                let name = Name::new(function.name(), NameMangling::Unknown, function.language());
                let file = location.file();
                serde_json::json!({
                    "function": demangled(&name),
                    "rawFunction": function.name(),
                    "symAddr": function.entry_pc(),
                    "file": file.map(|f| f.full_path()),
                    "line": location.line(),
                    "language": if function.language() == Language::Unknown { None } else { Some(function.language().name()) },
                })
            })
            .collect();
        out.push(serde_json::Value::Array(frames));
    }
    Ok(serde_json::Value::Array(out))
}

#[unsafe(no_mangle)]
pub extern "C" fn objects(ptr: *const u8, len: usize) -> u64 {
    let file = unsafe { input(ptr, len) };
    give(match list_objects(file) {
        Ok(json) => json.to_string().into_bytes(),
        Err(e) => error(e),
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn symcache(ptr: *const u8, len: usize, id_ptr: *const u8, id_len: usize) -> u64 {
    let file = unsafe { input(ptr, len) };
    let id = String::from_utf8_lossy(unsafe { input(id_ptr, id_len) }).to_string();
    give(match make_symcache(file, &id) {
        Ok(bytes) => {
            let mut out = Vec::with_capacity(bytes.len() + 1);
            out.push(0);
            out.extend(bytes);
            out
        }
        Err(e) => {
            let mut out = vec![1];
            out.extend(error(e));
            out
        }
    })
}

/// `addresses`: little-endian u64s
#[unsafe(no_mangle)]
pub extern "C" fn lookup(ptr: *const u8, len: usize, addr_ptr: *const u8, addr_len: usize) -> u64 {
    let cache = unsafe { input(ptr, len) };
    let raw = unsafe { input(addr_ptr, addr_len) };
    let addresses: Vec<u64> = raw.chunks_exact(8).map(|c| u64::from_le_bytes(c.try_into().unwrap())).collect();
    give(match lookup_addresses(cache, &addresses) {
        Ok(json) => json.to_string().into_bytes(),
        Err(e) => error(e),
    })
}

pub fn make_proguard_cache(mapping: &[u8]) -> Result<Vec<u8>, String> {
    let mapping = proguard::ProguardMapping::new(mapping);
    if !mapping.is_valid() {
        return Err("not a ProGuard mapping".into());
    }
    let mut out = Vec::new();
    proguard::ProguardCache::write(&mapping, &mut out).map_err(|e| e.to_string())?;
    Ok(out)
}

pub fn remap_proguard(cache: &[u8], frames: &serde_json::Value) -> Result<serde_json::Value, String> {
    let cache = proguard::ProguardCache::parse(cache).map_err(|e| e.to_string())?;
    let frames = frames.as_array().ok_or("frames must be a list")?;
    let mut out = Vec::new();
    for frame in frames {
        let class = frame["module"].as_str().unwrap_or("");
        let method = frame["function"].as_str().unwrap_or("");
        let line = frame["lineno"].as_u64().unwrap_or(0) as usize;
        let remapped: Vec<_> = cache
            .remap_frame(&proguard::StackFrame::new(class, method, line))
            .map(|f| {
                serde_json::json!({ "module": f.class(), "function": f.method(), "lineno": f.line(), "file": f.file() })
            })
            .collect();
        if remapped.is_empty() {
            // A class mapped without its method (or a frame without a line): at least its class
            out.push(match cache.remap_class(class) {
                Some(original) => serde_json::json!([{ "module": original, "function": method, "lineno": line }]),
                None => serde_json::json!([]),
            });
        } else {
            out.push(serde_json::Value::Array(remapped));
        }
    }
    Ok(serde_json::Value::Array(out))
}

#[unsafe(no_mangle)]
pub extern "C" fn proguardcache(ptr: *const u8, len: usize) -> u64 {
    let mapping = unsafe { input(ptr, len) };
    give(match make_proguard_cache(mapping) {
        Ok(bytes) => {
            let mut out = Vec::with_capacity(bytes.len() + 1);
            out.push(0);
            out.extend(bytes);
            out
        }
        Err(e) => {
            let mut out = vec![1];
            out.extend(error(e));
            out
        }
    })
}

/// `frames`: JSON `[{ module, function, lineno }]`
#[unsafe(no_mangle)]
pub extern "C" fn proguard(ptr: *const u8, len: usize, frames_ptr: *const u8, frames_len: usize) -> u64 {
    let cache = unsafe { input(ptr, len) };
    let frames = serde_json::from_slice(unsafe { input(frames_ptr, frames_len) }).unwrap_or(serde_json::Value::Null);
    give(match remap_proguard(cache, &frames) {
        Ok(json) => json.to_string().into_bytes(),
        Err(e) => error(e),
    })
}

pub fn make_sourcemapcache(minified: &str, map: &str) -> Result<Vec<u8>, String> {
    let writer = symbolic::sourcemapcache::SourceMapCacheWriter::new(minified, map).map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    writer.serialize(&mut out).map_err(|e| e.to_string())?;
    Ok(out)
}

pub fn lookup_sourcemap(cache: &[u8], positions: &[(u32, u32)]) -> Result<serde_json::Value, String> {
    use symbolic::sourcemapcache::{ScopeLookupResult, SourceMapCache, SourcePosition};
    let cache = SourceMapCache::parse(cache).map_err(|e| e.to_string())?;
    let out = positions
        .iter()
        .map(|&(line, column)| match cache.lookup(SourcePosition::new(line, column)) {
            None => serde_json::Value::Null,
            Some(location) => {
                let function = match location.scope() {
                    ScopeLookupResult::NamedScope(name) => Some(name.to_string()),
                    ScopeLookupResult::AnonymousScope => Some("<anonymous>".to_string()),
                    ScopeLookupResult::Unknown => None,
                };
                let line = location.line();
                let file = location.file();
                let context = |from: i64, to: i64| -> Vec<String> {
                    (from..to)
                        .filter(|n| *n >= 0)
                        .filter_map(|n| file.as_ref().and_then(|f| f.line(n as usize)).map(str::to_string))
                        .collect()
                };
                serde_json::json!({
                    "file": location.file_name(),
                    "line": line,
                    "column": location.column(),
                    "function": function,
                    "name": location.name(),
                    "pre": context(line as i64 - 5, line as i64),
                    "context": location.line_contents(),
                    "post": context(line as i64 + 1, line as i64 + 6),
                })
            }
        })
        .collect();
    Ok(serde_json::Value::Array(out))
}

#[unsafe(no_mangle)]
pub extern "C" fn sourcemapcache(ptr: *const u8, len: usize, map_ptr: *const u8, map_len: usize) -> u64 {
    let minified = String::from_utf8_lossy(unsafe { input(ptr, len) }).to_string();
    let map = String::from_utf8_lossy(unsafe { input(map_ptr, map_len) }).to_string();
    give(match make_sourcemapcache(&minified, &map) {
        Ok(bytes) => {
            let mut out = Vec::with_capacity(bytes.len() + 1);
            out.push(0);
            out.extend(bytes);
            out
        }
        Err(e) => {
            let mut out = vec![1];
            out.extend(error(e));
            out
        }
    })
}

/// `positions`: little-endian u32 pairs, 0-based line then column
#[unsafe(no_mangle)]
pub extern "C" fn sourcemap_lookup(ptr: *const u8, len: usize, pos_ptr: *const u8, pos_len: usize) -> u64 {
    let cache = unsafe { input(ptr, len) };
    let raw = unsafe { input(pos_ptr, pos_len) };
    let positions: Vec<(u32, u32)> = raw
        .chunks_exact(8)
        .map(|c| (u32::from_le_bytes(c[0..4].try_into().unwrap()), u32::from_le_bytes(c[4..8].try_into().unwrap())))
        .collect();
    give(match lookup_sourcemap(cache, &positions) {
        Ok(json) => json.to_string().into_bytes(),
        Err(e) => error(e),
    })
}
