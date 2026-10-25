type Note = { content?: { blocks: string[] } }

export function firstBlock(note: Note): string {
  return note.content!.blocks[0]
}

export function render(id: number) {
  const note: Note = id > 100 ? { content: { blocks: ['hello'] } } : {}
  return firstBlock(note)
}
