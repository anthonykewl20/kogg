# Kogg UI/UX audit

Date: 2026-08-28

## Executive assessment

The previous interface exposed Kogg's governed workflows through mostly unmodified
Theia chrome and minimally styled HTML forms. It was functional, but the product
read as an extension bundle rather than a deliberate engineering environment.
The largest competitive gap was not feature count; it was hierarchy, consistency,
interaction feedback, and perceived quality.

## Findings and disposition

| Area | Finding | Severity | Revision |
| --- | --- | --- | --- |
| Product shell | Stock blue status chrome, hard separators, and flat regions made the app feel like an older VS Code distribution. | High | Replaced with a neutral near-black shell, subtle separators, branded activity states, and restrained violet accents. |
| Visual hierarchy | Headings, descriptions, status text, and controls had similar weight. Users had to scan entire panels. | High | Introduced a consistent title rail, muted supporting copy, section cards, compact status pills, and stronger type hierarchy. |
| Forms | Native-looking inputs and buttons had weak focus, hover, disabled, and destructive states. | High | Added shared control sizing, focus rings, state transitions, secondary actions, destructive color cues, and responsive stacking. |
| Information density | Lists were divider-based and operational data lacked grouping. | Medium | Converted common lists into elevated rows and operational groups into bordered cards with tabular-number-friendly status surfaces. |
| Navigation | Activity and editor tabs had little product character or spatial feedback. | High | Added compact rounded targets, selected-state rails, hover feedback, and quieter inactive states. |
| Dialogs and command UI | Floating UI used legacy rectangular styling and visually overpowered the workspace. | Medium | Added softened geometry, translucent layered surfaces, restrained shadows, and calmer overlays. |
| Authentication | Sign-in was a generic dark card with no product trust cues or accessibility label. | Medium | Redesigned as a focused branded entry point with a labeled field, clear security context, responsive layout, and reduced-motion handling. |
| Accessibility | Focus treatment varied, reduced motion was not addressed, and some labels were visually weak. | High | Added global visible focus treatment, preserved semantic labels/status roles, increased muted-text contrast, and honored reduced motion. |
| Responsiveness | Toolbars and two-column rows could compress poorly in narrow side panels. | Medium | Added panel-aware wrapping, single-column form fallbacks, full-width mobile actions, and stable scroll gutters. |
| Feedback and motion | Most interactions changed abruptly or only by color. | Medium | Added short transform/color transitions for tabs, cards, buttons, and fields with a non-animated accessibility fallback. |

## Design principles

1. **Quiet canvas, obvious action.** Most surfaces stay neutral; violet is
   reserved for focus, selection, and primary actions.
2. **Density without clutter.** Spacing is compact but grouped into clear
   sections so operational workflows remain fast to scan.
3. **Depth through contrast, not decoration.** Borders and translucent layers
   establish hierarchy; gradients and shadows remain subtle.
4. **Governance stays visible.** Status, warnings, and blocked states remain
   prominent and are not hidden in decorative UI.
5. **Motion confirms cause and effect.** Short transitions clarify hover,
   selection, focus, and press states; reduced-motion preferences disable them.

## Follow-up opportunities

The shared visual system closes the largest consistency gap across every Kogg
widget. The next product-level iteration should focus on workflow architecture:
a dedicated home/command center, unified global search, progressively disclosed
advanced forms, keyboard-first project switching, and task-to-run navigation
that replaces several independent side-panel journeys.
