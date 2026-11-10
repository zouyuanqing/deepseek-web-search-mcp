# Architecture diagrams

LaTeX/TikZ sources for the diagrams embedded in the top-level README. The rendered
PNG files are committed so GitHub can display them without a LaTeX toolchain.

## Build

Requires TeX Live with TikZ and poppler's `pdftoppm`.

```powershell
cd docs/diagrams
foreach ($name in @('architecture', 'request-flow', 'eval-pipeline')) {
  pdflatex -interaction=nonstopmode -halt-on-error "$name.tex"
  pdftoppm -png -r 200 -singlefile "$name.pdf" "$name"
}
```

The generated `.aux`, `.log`, and `.pdf` files are ignored; commit the updated
`.png` files together with the `.tex` sources.
