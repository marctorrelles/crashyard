-- Whether a debug file's object has debug info (DWARF, PDB): 1, or only a symbol table: 0, as an app's executable
-- uploaded beside its dSYM under the same debug id. NULL for files uploaded before. Lookups prefer 1 (symbolicate.ts).
ALTER TABLE debug_files ADD COLUMN debug_info INTEGER;
