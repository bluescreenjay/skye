# Contract: Home UI (visual)

Source of truth: `specs/005-home-all-workspaces/mocks/home-design-prototype/` with `data-view="home"`.

Implement **Home only**. Do not mount the mock’s `#panel` / `#page` workspace layout.

## Layout (LTR)

```text
[ icon rail ~56px | main (scrolls) ]
```

Background: mock photo, cover, fixed. Rail: white, square, full height. Cards: light rounded rectangles on the photo.

## Rail (top → bottom)

1. Ungrouped / Other tab icons (~28px marks, 8px gap). Section scrolls if needed.
2. 1px hairline divider (accent at ~20% opacity).
3. Workspace tiles: ~36px rounded square with up to 2×2 tab marks. One tile per non-archived workspace. Section scrolls if needed.

No text labels on the rail. Selected/drop target: 2px accent ring or faint wash, not a glow.

## Main (top → bottom)

1. **Wordmark** “skye” — large, bold, white, on the photo (left of the url/greeting block as in the mock CSS grid).
2. **Url field** — placeholder `url bar`; not wired to navigate.
3. **Greeting** — white, thin; time + weather + work hint. Fallback if weather fails.
4. **Workspace cards** — vertical stack, ~16px gap, ~24px page padding. Main scrolls; rail stays.

### Collapsed card

Short. Left: editable name (accent, bold). Same row: as many tab icons as fit; clip extras (no “+N” pill). Click body (not name/icon) expands.

### Expanded card

Keep the header row. Below: three equal columns with vertical hairlines:

| Column | Content |
| --- | --- |
| Tabs | Scrollable rows: mark + lowercase title |
| Actions | ~3 accent buttons (`summarize`, `collect refs`, `new artifact`) as **stubs**; ask field placeholder `ask the workspace anything` |
| Artifacts | Stub list or `no artifacts yet` |

Only one card expanded at a time.

## Type and color (from mock)

- Family: Geist (or the same geometric sans with bold + thin cuts).
- All copy lowercase.
- On photo: white.
- On light: names/buttons/kind `#DB5B45`; body/placeholders `#4D626E`.
- Action buttons: solid accent, white label, ~8px radius, not pills.

## Forbidden (anti-AI-look)

Glassmorphism, sparkle empty states, centered hero, bento marketing, purple gradients, fake dashboard KPIs.

## Interaction

- Click tab mark/row: open `url` in a new browser tab; Home stays.
- Drag tab between card, rail tile, and Other rail; drop does not also click-open.
- Rename: inline contenteditable/input on the name; persist on Enter/blur.
- No create-workspace control.
- Empty/unpaired: same chrome, no cards, empty Other rail; never mock dummy names.
