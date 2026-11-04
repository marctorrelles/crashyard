-- Whether a debug file's object has debug info (DWARF, PDB): 1, or only a symbol table: 0, as an app's executable
-- uploaded beside its dSYM under the same debug id. NULL for files uploaded before. Lookups prefer 1 (symbolicate.ts).
-- 0040, after 0039 on the debug-retention branch: merge that one first.
ALTER TABLE debug_files ADD COLUMN debug_info INTEGER;
