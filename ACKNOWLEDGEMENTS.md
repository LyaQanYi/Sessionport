# Acknowledgements

sessionport's desktop UI borrows *design language and interaction patterns* from two MIT-licensed
projects. No source files were copied verbatim; the components in `apps/desktop/src/renderer` are
reimplemented against sessionport's own token layer.

## T3 Code / t3code

- Upstream: https://github.com/t3tools/t3
- License: MIT (Copyright (c) 2026 T3 Tools Inc.)
- Borrowed: zinc-based light/dark palette and compact density; 52px page header, 248px icon sidebar,
  46rem chat column; virtualised flat lists; collapsible tool/thinking rows in transcripts.

## CC Switch (cc-switch)

- Upstream: https://github.com/farion1231/cc-switch
- License: MIT (Copyright (c) 2025 Jason Young)
- Borrowed: semantic token naming (fg-1/2/3, surface, subtle, selected, ring as an accent colour);
  semantic radii (control 6px / panel 10px / dialog 14px); SettingsBlock + SettingsCard rows with
  the label on the left and the control on the right; segmented controls; the session manager's
  grouping by project/time with collapsible headers; app glyphs with brand-coloured tiles.

If you believe a file should carry an attribution header, open an issue and we will fix it.
