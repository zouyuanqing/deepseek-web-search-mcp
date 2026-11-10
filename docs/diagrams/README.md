# Architecture diagrams

LaTeX/TikZ sources for the diagrams embedded in the top-level README. The rendered
PNG files are committed so GitHub can display them without a LaTeX toolchain.

The README embeds the **section diagrams** (core / optional panel / main flow /
optional branches) because they are more readable at README width. The full
overview images are kept for reference: `architecture.png` and `request-flow.png`.

## Build

Requires TeX Live with TikZ and poppler's `pdftoppm`.

```powershell
cd docs/diagrams
foreach ($name in @(
  'architecture', 'architecture-core', 'architecture-openrouter',
  'request-flow', 'request-flow-main', 'request-flow-branches',
  'eval-pipeline'
)) {
  pdflatex -interaction=nonstopmode -halt-on-error "$name.tex"
  pdftoppm -png -r 200 -singlefile "$name.pdf" "$name"
}
```

The generated `.aux`, `.log`, and `.pdf` files are ignored; commit the updated
`.png` files together with the `.tex` sources.
