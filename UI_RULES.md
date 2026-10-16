# Electron Desktop UI Rules

Backend boundaries, registration, runtime, and path rules are defined in
[docs/MODULE_GUIDELINES.md](docs/MODULE_GUIDELINES.md). This document remains
the normative visual and interaction standard.

This document is a reusable UI standard for compact Electron workflow applications. MediaForge's SRT-to-Speech Studio is the measured reference implementation, while module names and workflow details below are implementation audit notes rather than dependencies of the standard.

Normative language:

- **Must**: required by this standard unless a documented product constraint prevents it.
- **Should**: preferred unless a module has a documented product reason to differ.
- **Module exception**: a behavior that remains local and must not be removed merely to match another module.

Rules marked as component standards are portable to other projects. App Shell measurements and the module audit tables describe the current MediaForge profile and may be replaced by an equivalent host profile in another application.

## 1. Design Philosophy

- **Scope — global:** use a compact, task-oriented desktop interface with a near-white canvas in light mode and charcoal surfaces in dark mode.
- Build hierarchy with typography, 1px hairlines, restrained surface changes, and one blue accent family.
- Keep panels flat. Shadows are reserved for floating overlays, not ordinary sections.
- Preserve business workflows. Standardization applies to visual role and sizing, not to module-specific behavior.
- Data and log regions should absorb remaining space and scroll internally.
- Every interactive component must expose a keyboard focus state and work in both themes.

## 2. Application Layout Architecture

MediaForge has two distinct layout layers:

1. **App Shell:** top bar, search, sidebar navigation, page/module header, iframe host, and dashboard.
2. **Module renderer:** the isolated SRT, Bilibili, SFX, or Hongguo document rendered inside the module frame.

The App Shell owns navigation and module reset. A module renderer owns only its workflow. Module CSS must not target parent-shell elements.

App Shell source metrics:

| Property | Standard value | Applies to | Exception |
| --- | ---: | --- | --- |
| Top bar height | 58px | .topbar | 50px at height ≤700px |
| Top bar horizontal padding | 22px | .topbar | none |
| Sidebar width | 207px | .sidebar | 171px at width ≤1040px |
| Content padding | 22px | .content | 14px at width ≤1040px; 11px 22px at height ≤700px |
| Module frame radius | 8px | .module-frame | none |
| Module frame border | 1px hairline | .module-frame | none |

The App Shell may use dashboard-specific dimensions such as 25px branding and 50px module icons. Those are shell components, not module-header standards.

## 3. Module Layout Structure

The SRT reference hierarchy is:

~~~text
main.app-container
├── section.controls-region             Input setup grid
├── section.model-settings              Model settings grid
├── section.processing-panel
│   ├── .processing-content             Header, status, progress
│   └── .processing-actions             Save, Retry, Cancel
└── .workspace
    ├── section.table-panel
    │   ├── .table-panel-header
    │   ├── .table-container
    │   │   ├── table                   Subtitle data grid
    │   │   └── .empty-state
    │   └── .table-footer               Page size, pagination, Go to
    └── aside.activity-panel
        ├── .log-header
        └── .log-console
~~~

SRT has two CSS form grids and one semantic data table:

| Grid | Wide definition | Contents | Responsive behavior |
| --- | --- | --- | --- |
| Input setup | three minmax(0, 1fr) fields plus content-aware Threads, Validate checkbox, and action group | SRT picker, voice picker, output picker, threads, ASR toggle, Validate/Create | At ≤1040px: two equal columns; action group spans both columns |
| Model settings | three minmax(0, 1fr) columns plus minmax(200px, 1.2fr) note | model, language, speaker, conditional note | Hidden model-specific children remain removed from layout with [hidden] |

The source contains one semantic table, Subtitle Segments. References to “two SRT grids” mean the two CSS layout grids above; they must not be misdocumented as two data tables. The data table is audited separately in section 10.

Module renderer structure should follow this order when the workflow supports it:

~~~text
Module shell
├── Setup controls
├── Optional secondary/model controls
├── Processing/progress
└── Flexible workspace
    ├── Primary content/data panel
    └── Activity/detail panel
~~~

Do not create an empty section merely to match this tree. SFX legitimately uses a single content flow and no data table.

## 4. Design Tokens

The canonical compact metrics are extracted from the current SRT source. Shared aliases may use different names, but their resolved values must match.

| Token / role | Standard value |
| --- | ---: |
| Module outer padding | 12px 16px |
| Module outer gap | 12px |
| Short-height outer padding/gap | 8px 12px / 8px |
| Standard panel padding | 16px |
| Standard panel gap | 12px |
| Processing panel padding | 11px 14px |
| Processing internal gap | 7px |
| Label-to-control gap | 7px |
| Control height | 40px |
| Large action height | 40px |
| Standard button height | 32px |
| Compact control height | 29px |
| Micro action height | 25px |
| Icon-only button size | 32×32px |
| Grid header/row height | 36px |
| Condensed grid header/row | 30px |
| Progress height | 7px |
| Base/body font size | 15px |
| Control font size | 13px |
| Table cell visual size | 14px |
| Caption font size | 12px |
| Picker icon | 18px |
| Large action icon | 16px |
| Standard action icon | 14px |
| Radius, controls/panels | 8px |
| Radius, buttons/progress | 980px |
| Border/divider | 1px |
| Interaction duration | 150ms |

Canonical spacing aliases are the values currently resolved by the SRT stylesheet:

~~~css
--space-1: 4px;
--space-2: 7px;
--space-3: 11px;
--space-4: 14px;
--space-5: 18px;
--space-6: 22px;
--space-10: 36px;
--space-12: 43px;
--space-14: 50px;
~~~

The 12px shell/panel gap and 16px shell/panel padding are explicit layout standards. They are not aliases for --space-3 and --space-4, whose actual values are 11px and 14px.

## 5. Spacing & Padding System

| Scope | CSS property | Standard | Applies to | Exceptions |
| --- | --- | ---: | --- | --- |
| Global | shell padding | 12px 16px | all module renderers | 8px 12px at height ≤700px |
| Global | shell gap | 12px | all module renderers | 8px at height ≤700px |
| Component | panel padding | 16px | table and activity panels | 12px at height ≤700px |
| Component | panel gap | 12px | table and activity panels | 8px at height ≤700px |
| Component | cell padding-inline | 16px | all data tables | narrow data-specific columns may use less only when documented |
| Component | icon/label gap | 7px standard, 8px log tools | buttons and controls | no arbitrary 6px gaps |
| Component | form gap | 7px | label to field | none |
| Component | workspace gap | 12px | non-resizable two-panel workspace | none |

Use gap for sibling spacing, padding for internal space, and margin only for deliberate separation such as a subtitle below a title. Do not stack margins and gaps for the same relationship.

## 6. Typography Standards

Use the system sans stack:

~~~css
-apple-system, BlinkMacSystemFont, "SF Pro Text", "SF Pro Display",
"Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif
~~~

| Role | Size | Weight | Tracking | Line height |
| --- | ---: | ---: | ---: | --- |
| Module title | 19px | 600 | -0.105px | normal |
| Panel title / large action | 15px | 600 / 400 | -0.272px | normal |
| Body | 15px | 400 | -0.272px | normal |
| Controls / standard buttons | 13px | 400 | -0.224px | normal or 1 for buttons |
| Table body | 14px | 400 | -0.224px | normal |
| Labels / table header / log | 12px | 600 / 400 | -0.264px | normal; log 1.6 |

Use only weights 400 and 600 in standard UI. Apply tabular numerals to time, duration, speed, percentages, pagination, and counters. Compact paths and table values must use one-line ellipsis; logs may wrap anywhere and preserve deliberate line breaks.

## 7. Icon Standards

- Use inline SVG with currentColor; do not mix emoji, raster toolbar icons, or unrelated icon libraries.
- Picker icons are 18px. Large primary action icons are 16px. Standard, micro, and Clear-action icons are 14px. Theme icons are 16px inside a 32px circle.
- Use approximately 1.5–1.8 stroke width with round caps/joins for outline icons.
- Filled play triangles may use fill: currentColor.
- Decorative/module brand marks use the decorative accent; action icons inherit their button color.
- An action without an icon is valid. Do not add a decorative icon solely to equalize button width.

## 8. Button Standards

| Variant | Height | Horizontal padding | Font | Icon | Visual treatment |
| --- | ---: | ---: | --- | ---: | --- |
| Large primary/secondary | 40px | 22px | 15px | 16px when present | filled accent / accent outline |
| Standard | 32px | 14px | 13px | 14px | role-specific |
| Compact row action | 29px | 7px | 13px | 14px | outline or neutral |
| Micro panel tool | 25px | 11px | 12px | 14px | neutral outline |
| Icon-only | 32×32px | 0 | n/a | 16px | circular hairline |

Global button rules:

- Use inline flex, centered alignment, a pill radius, no text wrapping, and no movement/scale on hover.
- Primary hover uses the theme accent-hover token.
- Secondary hover fills with accent-outline and changes text to on-accent.
- Destructive/cancel buttons in the reference are neutral outlines; semantic danger color is reserved for destructive confirmation/status, not required as a permanent fill.
- Disabled primary buttons use disabled fill and disabled text. Disabled outline buttons retain a hairline and disabled text.
- Focus uses the global 2px accent outline with 2px offset.

Validate/Create requirement:

- #validate-button and #create-button use the same large-action metrics: 40px height, 22px horizontal padding, 15px/400 type, 7px gap, pill radius, and centered inline-flex alignment.
- Both are flex: 1 1 0 with min-width: 0 inside the same action group, so their rendered widths are exactly equal without a hard-coded guessed width.
- Validate keeps its outlined color and callback. Create Audio keeps its filled color, 16px play icon, label, and callback.

## 9. Form Control Standards

| Control | Height | Padding | Type | Notes |
| --- | ---: | --- | --- | --- |
| Text/select/picker | 40px | 0 14px | 13px | 1px border, 8px radius |
| Compact select/input | 29px | 0 7px | 12px | pagination/filter use |
| Checkbox | 18×18px | n/a | native | accent-color uses theme accent |
| Multi-line textarea | module-specific | 10px 12px | 13px, 1.35 line | minimum height 40px |

- Labels are 12px/600 with a 7px label-to-control gap.
- File/folder pickers must be real buttons that open native dialogs. Paths are single-line and ellipsized.
- Select wrappers may draw a 12–14px chevron and reserve trailing space for it.
- Hover changes only border color. Focus uses the global focus ring.
- Disabled controls use disabled-control background, disabled text, and not-allowed.
- Number inputs use tabular numerals; center only short page/count inputs.

## 10. Grid & Data Table Standards

SRT Subtitle Segments audit:

| Property | Resolved behavior |
| --- | --- |
| Container | flex-growing, both axes auto, stable scrollbar gutter, 1px border, 8px radius |
| Table | fixed layout, 1042px configured width, 100% minimum |
| Header | sticky top 0, z-index 1, surface background, 36px |
| Row | 36px; 30px at height ≤700px |
| Cell | 16px horizontal padding, 14px body type, one line, ellipsis |
| Columns | ID 64; Duration 290; Text 300; Speed 88; Status 120; Actions 180px |
| Alignment | ID/status/actions centered; prose left; numeric values tabular |
| Hover | subtle app-canvas surface |
| Selected | no selected-row state |
| Empty | centered flex message in remaining viewport |
| Sort | not implemented |
| Manual column resize | intentionally not implemented |
| Render | renderer creates semantic rows/cells; long content receives truncation |
| Pagination | Auto/10/20/50/100, centered pills, 29px controls, Go to input |

There is no second SRT data table in the current source. The two SRT CSS grids are documented separately in section 3. Future audits must report this distinction instead of inventing a second table.

Cross-module visual rules:

- Use one semantic table for header and body so horizontal scrolling cannot desynchronize columns.
- Use 36px rows, 30px short-height rows, 16px cell padding, 12px/600 headers, and 14px body cells.
- Keep header and body column definitions identical through table-layout: fixed.
- Use per-grid CSS tokens for configured column widths and the table minimum width. Automatic responsive calculations may update system-owned geometry.
- Manual column resizing is prohibited. Do not render resize handles, use a `col-resize` cursor, register pointer/keyboard resize listeners, or persist user-defined column widths.
- Provide horizontal scrolling rather than wrapping or hiding columns.
- Preserve sort, selection, and row actions when they are part of the workflow.
- Long single-line content must use ellipsis. Put the complete value in `title` or an accessible detail affordance when users need it.
- Empty and loading states occupy the remaining table viewport without adding fake rows. Loading must not alter column geometry.
- Row selection must use a native checkbox or an equivalent keyboard-accessible control; header selection applies to the rows represented by the current view.
- Themes may change tokens only; row height, padding, column width, overflow, and scroll behavior remain unchanged.

Current table configurations:

| Module | Minimum/default width | Columns | Functional behavior |
| --- | ---: | --- | --- |
| SRT | 1042px | 64 / 290 / 300 / 88 / 120 / 180 | filter + pagination; fixed CSS widths |
| Bilibili | 1034px | 64 / 280 / 290 / 120 / 120 / 160 | status filter + pagination; fixed CSS widths |
| Hongguo | 1050px | 56 / 88 / 280 / 116 / 96 / 104 / 108 / 80 / 122 | status filter + sort + selection + pagination; fixed CSS widths |

All three current tables use system-configured widths and expose no manual column-resize state, handle, listener, or persistence.

## 11. Status Filter Standards

The status filter is a view control, not a job command.

| Property | Required value / behavior |
| --- | --- |
| Position | Trailing edge of the data-panel header, beside the panel title |
| Structure | Visible `Status` label + relative select wrapper + native `select` + 12px chevron |
| Height | 29px |
| Padding | 14px inline-start, 28px inline-end; chevron 10px from the trailing edge |
| Typography | 12px/400 select text; 12px/600 label; -0.264px tracking |
| Shape | 1px theme hairline, 8px radius, control surface background |
| Spacing | 7px between label and select |
| Default | `All` |
| Hover | border changes to the border-hover token only |
| Focus | global 2px accent outline with 2px offset |
| Disabled | disabled-control surface, disabled text, not-allowed cursor |

- Options after `All` must come from the module's actual status domain. Do not copy another module's status names.
- Normalize backend aliases that mean the same state before filtering; expose one user-facing option for one semantic state.
- Options must be unique. A filter changes neither the source collection nor a job's status.
- Changing the filter immediately resets Current Page to 1 and rerenders the derived view.
- The title/count reports the filtered item count and source total (`N of M`) when filtered; `M total` is valid for `All`.
- A zero-result filter shows a contextual empty message naming the selected status. It must not use the source-empty message.
- Status transitions received while work is running must reevaluate the filter and page count without resetting sort, page size, selection, or unrelated controls.
- The filter must remain readable and geometrically identical in light and dark themes.

The current status domains are implementation examples only: synthesis exposes All/Success/Fail; one downloader normalizes Done and Completed into Completed; another downloader includes its real analysis and queue states. Future projects must define their own domain mapping.

## 12. Sorting & Filtering Pipeline

Every data view must derive rows in this order:

~~~text
Source Data → Status Filter → Sort → Pagination → Render
~~~

- Each stage returns or derives a view; it must not mutate the source collection.
- A filter or sort change resets Current Page to 1. A status-only data update keeps Current Page when it remains valid.
- Sorting applies to the entire filtered result before slicing the current page.
- Sortable headers must expose keyboard activation and `aria-sort`; sorting must not alter selection or job state.
- When the filtered/sorted item count changes, clamp Current Page before rows are sliced and rendered.
- Real-time events may patch a row in place only when its normalized status and sort position are unchanged. Otherwise rerun the full pipeline.

## 13. Pagination Standards

The reference footer has three logical regions: page-size control at the start, page navigation centered, and Go to control at the end. Grid or flex implementation is allowed if those roles stay aligned and can reflow without overlap.

| Property | Required value / behavior |
| --- | --- |
| Footer gap | 14px between logical regions |
| Page size label | `Show [select] per page` |
| Page sizes | `Auto`, `10`, `20`, `50`, `100` |
| Compact controls | 29px high; select follows Status Filter metrics |
| Navigation gap | 7px |
| Page button | 29px height and minimum width; 7px inline padding; pill radius |
| Page text | 13px with tabular numerals |
| Active page | accent background and on-accent text; `aria-current="page"` |
| Disabled navigation | disabled text, default cursor, native `disabled` state |
| Go to input | 52×29px, 7px inline padding, centered 12px tabular text, 8px radius; numeric input with `min=1`, `step=1`, and numeric keyboard hint; native spinner buttons hidden |
| Page window | At most five consecutive numbered pages, with first/last shortcuts and ellipsis when needed |
| Navigation | First `«`, Previous `‹`, Next `›`, Last `»`, each with an accessible label |

- `Total Pages = max(1, ceil(filteredItemCount / effectivePageSize))`.
- Current Page is always clamped to `[1, Total Pages]` before row slicing. A reduced result set must never render a transient blank page caused by an out-of-range page.
- Changing page size resets Current Page to 1.
- `Auto` computes the number of complete body rows that fit beneath the header, with a minimum of one. A `ResizeObserver` may recompute it after window or layout changes; this is automatic pagination, not manual grid resizing.
- Empty data still reports page 1 of 1 and disables First/Previous/Next/Last.
- One-page data uses the same footer and disabled navigation states; controls must not jump or disappear.
- Go to accepts decimal digits only while editing; reject signs, decimal separators, exponent notation, and other non-digit characters. A temporarily empty value is allowed so the user can replace it manually.
- Hide the Go to number input's native increment/decrement spinner in every supported browser without changing its numeric semantics, constraints, keyboard behavior, or pagination handlers.
- Go to preserves manual entry, clamps the committed integer to `[1, Total Pages]`, and commits on change or Enter.
- Item creation, deletion, reset, clear, and live status updates preserve the current page when valid and clamp it when not.
- Pagination is renderer state only and must not change queue order, source records, active downloads, or persisted job status.

## 14. Processing & Progress Standards

- Processing is a bordered 8px-radius surface with status/progress content growing and actions kept intrinsic.
- Reference processing padding is 11px 14px; content gap is 7px; action gap is 11px.
- Status and percentage use 13px text. Percentages and elapsed time use tabular numerals.
- Progress is full width, 7px high, borderless, and pill-shaped. Track uses disabled fill; value uses accent.
- Actions may wrap; they must not shrink into unreadable labels.
- At ≤1040px, processing may wrap with actions taking a full row.
- Idle, running, completed, failed, paused, canceling, and retry states change text, semantic color, progress, and disabled state only. Do not change job/cancel/retry logic as part of styling.

## 15. Activity Log Standards

- Panel padding/gap: 16px / 12px; 12px / 8px in short-height mode.
- Header title: 14px/600 with -0.224px tracking.
- Clear action: 25px high, 14px trash icon, 8px icon-label gap.
- Log viewport: flex-growing, min-height: 0, 16px padding, vertical auto overflow, stable scrollbar gutter, 1px border, 8px radius.
- Log text: system sans, 12px/400, 1.6 line height. Use monospace only for genuinely alignment-sensitive command/code output.
- Timestamp: disabled/muted color and tabular numerals.
- Normal message: primary text. Success, warning, and error use semantic tokens.
- Empty state remains visible when no entries exist.
- Auto-scroll is behavioral: scroll only when the user was already near the bottom. Clear must keep its existing callback and scope.

## 16. Header & Navigation Standards

Module header:

- The current embedded SRT markup starts at setup controls; its visible title/navigation is supplied by the App Shell. The metrics below apply when a standalone module renders its own header and to equivalent shell/module header roles.
- Horizontal flex, centered, 11px gap, 11px bottom padding, 1px bottom hairline.
- Brand mark 22×22px.
- Title 19px/600.
- Optional subtitle 12px muted, one-line ellipsis.
- Trailing global action uses margin-inline-start: auto.
- Theme action is 32×32px with a 16px icon.

App Shell navigation:

- Top bar and sidebar belong to the host, not individual modules.
- Navigation row height is 40px, icon 18px, radius 8px.
- Active navigation uses accent fill/on-accent text; inactive module icons may use accent.
- Disabled navigation stays visible and does not navigate.
- The module switch guard and reset behavior are functional contracts and must not be bypassed by UI refactors.

## 17. Color & Theme Standards

| Role | Light | Dark |
| --- | --- | --- |
| App canvas | #f5f5f7 | #1d1d1f |
| Surface/control | #ffffff | #2c2c2e |
| Subtle hover | #f5f5f7 | #1d1d1f |
| Disabled fill | #e2e2e5 | #3a3a3c |
| Primary text | #1d1d1f | #f5f5f7 |
| Secondary text | #474747 | #b8b8bd |
| Muted text | #707070 | #a1a1a6 |
| Disabled text | #858585 | #6e6e73 |
| Hairline | #d2d2d7 | #48484a |
| Border hover | #707070 | #a1a1a6 |
| Accent | #0071e3 | #2997ff |
| Accent hover | #0077ed | #3aa0ff |
| Accent outline | #0066cc | #66b3ff |
| Success | #1d7a3e | #32d74b |
| Warning | #a16207 | #eab308 |
| Error | #d70015 | #ff453a |

- Set color-scheme on the root for native control/scrollbar parity.
- Change tokens, not component selector structure, between themes.
- Theme changes must not alter dimensions, borders, or layout.
- Theme persistence keys remain module-scoped.

## 18. Border, Radius & Divider Standards

- Standard border/divider is 1px solid hairline.
- Inputs, panels, tables, logs, and compact number fields use 8px radius.
- Buttons, pagination, and progress use 980px radius.
- Ordinary panels have no decorative shadow.
- Do not place a divider or resize handle between a data grid and its Activity Log.
- Do not add nested borders unless the child is a functional scroll viewport such as a table or log.

## 19. Scrollbar & Overflow Standards

- Use native scrollbars and color-scheme; do not hard-code scrollbar colors.
- Shell/workspace/panel flex and grid descendants must declare min-width: 0 and min-height: 0 where shrinking is required.
- Wide desktop mode uses hidden overflow at shell/workspace level and auto overflow on tables/logs.
- Tables use both-axis auto overflow and a stable gutter. Logs use vertical auto overflow and a stable gutter.
- Paths, titles, status text, and cells use ellipsis. Logs use overflow-wrap: anywhere.
- Never solve overflow by hiding a required action, setting, or data column.

## 20. Responsive & Window Size Standards

Baseline window is 1180×780px. Standalone module windows use a 900×650px minimum. Embedded module CSS must still tolerate a narrower iframe because the App Shell occupies part of the native window.

At width >1040px:

- Setup grids use their wide definitions.
- Grid and Activity Log workspaces use minmax(0, 4fr) minmax(240px, 1fr) with a 12px gap.

At width ≤1040px:

- Workspaces stack into one column.
- Primary table panels use at least 400px height; log panels use at least 320px.
- Setup controls reflow; actions may span columns and share width.
- Hongguo retains every setup option and selection control.

At height ≤700px:

- Shell becomes 8px gap with 8px 12px padding.
- Panels become 12px padding with 8px gap.
- Grid rows become 30px.
- Do not reduce control/font metrics or hide functional sections.

### Rule: Grid & Activity Log Layout

1. Do not use a draggable splitter between a Grid and Activity Log.
2. Do not allow users to manually change the width of either area.
3. Use a default 80% / 20% layout (`minmax(0, 4fr) minmax(240px, 1fr)`), subject to the Activity Log minimum width and the responsive stacking breakpoint.
4. Both areas must resize automatically with the application window, share the same row height, and remain within their parent container.
5. Keep spacing, borders, backgrounds, and border radii synchronized across modules through the existing shared component standards.
6. Do not render a resize handle, resize cursor, separator track, or leftover gap reserved for one.
7. Reuse the existing workspace and panel patterns instead of adding module-specific resize implementations.

## 21. Component States & Feedback

| State | Required feedback |
| --- | --- |
| Hover | border or surface token change; no movement |
| Active | same family as hover; no scale/inset jump |
| Keyboard focus | 2px accent outline, 2px offset |
| Disabled | disabled text/surface and not-allowed cursor |
| Loading | stable button width; status/progress or aria-busy |
| Success | success text token |
| Warning | warning text token |
| Error | danger text token and readable message |
| Empty | centered muted message without collapsing the viewport |
| Selected | only where selection exists; native checkbox or explicit accessible state |

Dynamic status/log regions use polite live announcements. Do not rely on color alone when a text label can communicate the state.

## 22. Shared Component Reuse Policy

- The shared shell tokens in frontend/src/shared/styles/tokens.css are the canonical aliases for host components and the baseline for isolated renderer token blocks.
- Reuse the same primitive shape for buttons, pickers, selects, panels, progress, tables, and logs.
- Isolated renderer documents may duplicate token declarations because iframe styles do not cross document boundaries; values and roles must remain synchronized.
- Prefer role variants such as primary, secondary, ghost, danger, compact, large, and micro over operation-specific copies.
- Keep business event listeners and renderer state out of styling refactors.
- Inline styles are allowed only for genuinely dynamic values such as progress; workspace ratios and table column widths remain system-owned CSS values.

## 23. MediaForge Implementation Notes

### SRT-to-Speech Studio

- Source of truth for visual metrics.
- Subtitle columns and panel allocation are CSS-managed; no manual table/panel resize.
- Auto page size may use ResizeObserver.
- Validate ASR, Create Audio, save, retry, cancel, audio playback, filtering, and pagination behavior remain unchanged.

### Bilibili Video Downloader

- Must preserve cookie/account validation, download queue/progress, network speed, navigation guard, and in-session state restoration.
- Table columns are fixed by CSS tokens. The former handles, pointer/keyboard resizing, width state, and width persistence have been removed.
- Status filtering uses the downloader's Queued, Downloading, Processing, Completed, Failed, and Cancelled domain; Done is normalized to Completed.
- Pagination follows the reference Auto/10/20/50/100 contract and is applied after filtering.
- Downloads and Activity Log use the shared fixed 80% / 20% responsive workspace; no splitter state, persistence, or input listeners are permitted.

### SFX-Converter

- Single-flow layout is valid; no data table or artificial split workspace is required.
- Preserve model selection, SFX extraction, audio processing, progress, output handling, native picker, and error dialog behavior.

### Hongguo Downloader

- Preserve analysis, selection/range, sortable episode table, queue controls, progress, action buttons, reset/data management, and navigation guard.
- Columns are fixed by CSS tokens and must not expose manual resize.
- Status filtering covers the real analysis and queue states. Sorting runs after filtering and before pagination.
- Pagination follows Auto/10/20/50/100; the header checkbox targets the currently rendered filtered page while the explicit Select All action retains its source-wide meaning.
- All setup options remain visible when responsive; reflow instead of hiding controls.

## 24. UI Quality Assurance Checklist

- [ ] Validate and Create Audio render at identical width and height.
- [ ] Both actions retain their labels, color roles, icons (where present), callbacks, focus, and disabled states.
- [ ] Module shell is 12px 16px with 12px gap at baseline.
- [ ] Equivalent panels use 16px padding and 12px gap.
- [ ] Controls resolve to 40/32/29/25px variants.
- [ ] Table header/body align and resolve to 36px rows (30px short-height).
- [ ] No grid exposes a resize handle, `col-resize` cursor, resize listener, user-width state, or column-width persistence.
- [ ] Long values ellipsize and remain available through title/detail where needed.
- [ ] Status defaults to All, uses the module's real domain, resets to page 1, and updates filtered/total counts.
- [ ] Filter → sort → pagination order remains correct during live status updates.
- [ ] Pagination uses Auto/10/20/50/100, clamps Current Page, and handles empty/one-page/multi-page data.
- [ ] Tables/logs own their scrollbars; no clipped controls or overlapping panels.
- [ ] Light and dark themes keep identical geometry and readable contrast.
- [ ] Grid and Activity Log workspaces expose no resize handle, resize cursor, splitter listener, or persisted user width.
- [ ] Hongguo sort and selection still work; no responsive control is hidden.
- [ ] SFX processing, model selection, picker, output, and dialog behavior remain intact.
- [ ] Module switching, reset, theme, progress, cancel, retry, and log-clear behavior remain intact.
- [ ] JavaScript syntax checks, tests, and available runtime health checks have been run and reported honestly.

## 25. Rules for Future Module Development

1. Start from the shared semantic tokens and primitive roles; do not invent a parallel palette or scale.
2. Use the module structure appropriate to the workflow, not a mechanical copy of SRT.
3. Declare data-specific table column tokens beside the table minimum width.
4. Do not add manual table-column resizing. Configure widths with tokens or system-owned responsive calculations and use horizontal scrolling when the configured total exceeds the viewport.
5. Keep functionality visible during responsive reflow.
6. Implement both themes at the same time and test geometry in each.
7. Test at 1180×780, 900×650, ≤1040px content width, and ≤700px height.
8. Verify empty, populated, long-text, running, completed, failed, disabled, hover, focus, and overflow states.
9. Keep filesystem access and long-running work outside the renderer.
10. Update this document when a new visual role or approved module exception is introduced.
