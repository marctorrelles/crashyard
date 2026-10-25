# Components

- `ui/`: shadcn/ui (style `radix-nova`, neutral, `components.json` at the root). Added with
  `pnpm dlx shadcn@latest add <name>`; kept as upstream writes them, so they can be re-added with `--overwrite`. After
  adding one, fix its `cn` import to `@/lib/utils` if the CLI wrote `"cn"`. The theme's colours are in `src/styles.css`.
- Our own components sit beside `ui/`, built from those. Every one works on a phone (touch targets of 40 px or more,
  nothing wider than the screen) and in light and dark.
