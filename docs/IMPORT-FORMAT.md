# Remento card format — reference for AI generation

Upload this file to any AI (Claude, ChatGPT, Gemini) together with your lecture slides, notes or
textbook pages, and ask it to produce flashcards. It returns a payload you paste into Remento's
Import tab.

---

## Instruction block — paste this with the file

> Read the attached format reference. Using the attached course material, produce flashcards for
> **[SUBJECT] — [UNIT]**.
> Return **JSON only**, in a single code block, conforming to the schema in the reference.
> Aim for **[N] cards**. Follow every rule in the "Writing rules" section.
> Do not repeat any of these fronts, which already exist: **[PASTE EXISTING FRONTS]**

Remento's **Copy AI prompt** button builds this block for you, with the destination and the
existing fronts already filled in.

---

## JSON — the canonical format

```json
{
  "remento": 1,
  "target": {
    "semester": "s3",
    "subject": "Thermodynamics",
    "unit": { "no": 2, "title": "Second Law and Entropy" }
  },
  "defaults": { "tags": ["thermo"], "importance": 2 },
  "cards": [ ... ]
}
```

`target` is a **suggestion**; the user confirms or changes the destination in the import preview.
`defaults` apply to any card that does not set the field itself.

### Card envelope

Every card has this shape. Only `type` and `content` are required.

```json
{
  "id":         "thermo-u2-007",
  "type":       "qa",
  "content":    { },
  "why":        "why this matters / where it shows up",
  "trap":       "the mistake people make",
  "source":     "Cengel 9e p.283  |  Own notes p.16  |  Slides L4 s.22",
  "figure_ref": "where to find the diagram, and what to label in what order",
  "importance": 3,
  "marks":      10,
  "reverse":    false,
  "tags":       ["definition", "second-law"]
}
```

| Field | Meaning |
|---|---|
| `id` | Stable identifier. **Re-importing a card with the same `id` updates it and keeps its review schedule.** Use `subject-unit-nnn`. |
| `type` | One of `qa`, `cloze`, `formula`, `list`, `numerical`, `image` |
| `content` | Type-specific — see below. **Always an object, for every type.** |
| `importance` | 1 = recognise it · 2 = know it · 3 = load-bearing for the exam |
| `marks` | What this is worth if asked directly. Optional. |
| `reverse` | Generate a reverse card with its own schedule. Formula and term↔definition only. |

Text fields accept a small amount of HTML: `<strong> <em> <br> <ul> <li> <code> <sup> <sub>`.
LaTeX is written `$inline$` and `$$display$$`.

**Two equations on one card:** in JSON, put both in one `latex` string joined with `\\` (a LaTeX
newline). In the text format, write two consecutive `$$…$$` blocks and the importer joins them the
same way. Use this where a rate form and a per-unit-mass form belong on the same card — the SFEE
card in `data/thermo-unit2.txt` is the worked example.

### The six content shapes

**qa** — the default. Use for anything that is a question with an answer.
```json
{ "type": "qa",
  "content": {
    "front": "State the Kelvin–Planck statement of the second law.",
    "back": "It is impossible for any device operating on a cycle to receive heat from a single reservoir and produce a net amount of work."
  },
  "trap": "'Single reservoir' is the load-bearing phrase.",
  "importance": 3 }
```

**formula** — an equation with its symbols and units.
```json
{ "type": "formula",
  "content": {
    "prompt": "State the Clausius inequality and say what it forbids.",
    "latex": "\\oint \\frac{\\delta Q}{T} \\le 0",
    "note": "Equality holds only for a fully reversible cycle.",
    "symbols": [
      { "sym": "\\delta Q", "means": "differential heat transfer at the boundary", "unit": "J" },
      { "sym": "T", "means": "absolute boundary temperature", "unit": "K" }
    ]
  },
  "trap": "T is the boundary temperature, not the system's.",
  "reverse": true }
```

**list** — an enumeration. **Always state the count in the prompt implicitly by listing every item.**
```json
{ "type": "list",
  "content": {
    "prompt": "Name the four processes of the Carnot cycle, in order.",
    "ordered": true,
    "items": ["Reversible isothermal expansion", "Reversible adiabatic expansion",
              "Reversible isothermal compression", "Reversible adiabatic compression"]
  } }
```

**cloze** — fill in the blanks. Wrap each blank in `{{ }}`. Use only where a single sentence has
genuinely removable phrases; do not force it.
```json
{ "type": "cloze",
  "content": {
    "text": "Carnot efficiency depends only on {{the absolute temperatures of the two reservoirs}} and never on {{the working fluid}}.",
    "blanks": 2
  } }
```

**numerical** — a value worth recalling cold.
```json
{ "type": "numerical",
  "content": {
    "prompt": "Triple point of water — temperature and pressure.",
    "value": "273.16 K, 0.6117 kPa",
    "context": "The fixed point that defines the Kelvin."
  } }
```

**image** — the picture is the question, or the answer is a diagram. **Do not generate the image.**
Use `figure_ref` to say where the real diagram is.
```json
{ "type": "image",
  "content": {
    "front": "Sketch the T–v diagram of a pure substance. Label the vapour dome and the critical point.",
    "back": "Dome with saturated liquid line left, saturated vapour line right, meeting at the critical point..."
  },
  "figure_ref": "Own notes p.6 right-hand page. Google: 'T-v diagram pure substance vapor dome'. Label in this order: saturated liquid line, saturated vapour line, critical point, three regions." }
```

---

## Plain-text format — for quick sets and hand-editing

Header directives, then blocks separated by `---` on its own line.

```
@semester: 3
@subject: Thermodynamics
@unit: 2 — Second Law and Entropy
@tags: second-law
@importance: 2

Q: State the Kelvin–Planck statement of the second law.
A: It is impossible for any device operating on a cycle to receive heat from a
   single reservoir and produce a net amount of work.
trap: "Single reservoir" is the load-bearing phrase.
src: Cengel 9e p.283
imp: 3
tags: +definition
---

F: State the Clausius inequality and say what it forbids.
$$\oint \frac{\delta Q}{T} \le 0$$
sym: \delta Q | differential heat transfer at the boundary | J
sym: T | absolute boundary temperature | K
trap: T is the boundary temperature, not the system's.
rev: yes
---

L: Name the four processes of the Carnot cycle, in order.
- Reversible isothermal expansion
- Reversible adiabatic expansion
- Reversible isothermal compression
- Reversible adiabatic compression
---

C: Carnot efficiency depends only on {{the absolute temperatures of the two
   reservoirs}} and never on {{the working fluid}}.
---

N: Triple point of water — temperature and pressure.
= 273.16 K, 0.6117 kPa
ctx: The fixed point that defines the Kelvin.
---
```

**Type markers** — `Q:` qa · `F:` formula · `L:` list · `C:` cloze · `N:` numerical · `I:` image
**Modifiers** — `A:` answer · `why:` · `trap:` · `src:` · `fig:` · `imp:` 1–3 · `marks:` ·
`tags:` (`+x` adds to header tags; a bare list replaces them) · `rev: yes` · `sym:` (formula only) ·
`=` (numerical value) · `ctx:` (numerical context) · `-` (list item) · `ord: yes` (list is ordered)

`why:` and `ctx:` are different fields and are not interchangeable. `why:` is why the card matters
to you; `ctx:` is the surrounding fact a numerical value needs to make sense. A list is unordered
unless it carries `ord: yes` — order only matters when being asked for them out of sequence would
cost a mark.

Continuation lines are indented. A blank line inside a block is allowed. `---` alone ends a card.

---

## Writing rules

These decide whether a generated card is worth drilling.

1. **Reproduce the source's own wording** for definitions and classifications. Where the source
   contradicts the standard textbook, use the source's version and note the difference in `trap`.
2. **Every list card lists every item.** A partial list teaches a wrong count.
3. **Every formula card carries its trap** — the sign convention, the validity limit, the unit that
   catches people out.
4. **One fact per card.** A card asking two things cannot be graded honestly.
5. **The front must be answerable without seeing the back.** Never "Explain the above."
6. **Prefer the lecturer's phrasing** where slides and textbook differ — that is what gets marked.
7. **Cite the source** when you can: file, page or slide number.
8. **Set `importance` honestly.** 3 = load-bearing for the exam; 1 = recognise it if it appears.
   If everything is a 3, the field is useless.
9. **Set `reverse` only** on formula cards and clean term↔definition pairs.
10. **Never invent a number.** A value not in the source does not go on a card.
11. **Do not generate diagrams.** Point at where the real one is with `figure_ref`, and say what to
    label in what order.
12. **Prefer `qa`, `formula` and `list`.** Use `cloze` only where a sentence has genuinely
    removable phrases, and `numerical` only for values worth memorising.
