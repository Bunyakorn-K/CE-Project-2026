---
name: LaundryTwin Operations Workspace
description: Calm, evidence-first operations UI for commercial laundry teams.
colors:
  canvas: "#f4f7f6"
  surface: "#ffffff"
  surface-muted: "#edf4f2"
  brand: "#0f6269"
  brand-dark: "#123b40"
  ink: "#12353a"
  ink-soft: "#4e686b"
  muted: "#829496"
  border: "#d7e3e0"
  border-strong: "#b8ccca"
  success: "#087a5b"
  success-bg: "#e5f6ee"
  warning: "#9a5a00"
  warning-bg: "#fff4d6"
  danger: "#b42318"
  danger-bg: "#fdecea"
  info: "#2166a8"
  info-bg: "#eaf2fb"
typography:
  display:
    fontFamily: "Noto Sans Thai, Avenir Next, Helvetica Neue, system-ui, sans-serif"
    fontSize: "32px"
    fontWeight: 800
    lineHeight: "1.12"
    letterSpacing: "-0.035em"
  headline:
    fontFamily: "Noto Sans Thai, Avenir Next, Helvetica Neue, system-ui, sans-serif"
    fontSize: "19px"
    fontWeight: 800
    lineHeight: "1.4"
    letterSpacing: "-0.02em"
  body:
    fontFamily: "Noto Sans Thai, Avenir Next, Helvetica Neue, system-ui, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: "1.6"
    letterSpacing: "normal"
  label:
    fontFamily: "Noto Sans Thai, Avenir Next, Helvetica Neue, system-ui, sans-serif"
    fontSize: "12px"
    fontWeight: 700
    lineHeight: "1.4"
    letterSpacing: "0"
  data:
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace"
    fontSize: "11px"
    fontWeight: 700
    lineHeight: "1.4"
    letterSpacing: "0"
rounded:
  sm: "8px"
  md: "10px"
  lg: "14px"
  panel: "18px"
spacing:
  xs: "6px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "20px"
  2xl: "24px"
  3xl: "32px"
components:
  button-primary:
    backgroundColor: "{colors.brand}"
    textColor: "{colors.surface}"
    rounded: "{rounded.md}"
    padding: "0 16px"
    height: "44px"
  button-secondary:
    backgroundColor: "{colors.surface-muted}"
    textColor: "{colors.brand-dark}"
    rounded: "{rounded.md}"
    padding: "0 16px"
    height: "44px"
  button-outline:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.brand-dark}"
    rounded: "{rounded.md}"
    padding: "0 16px"
    height: "44px"
  card-surface:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.lg}"
    padding: "20px"
  input-field:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    height: "42px"
  nav-link-active:
    backgroundColor: "{colors.surface-muted}"
    textColor: "{colors.brand-dark}"
    rounded: "{rounded.md}"
    padding: "9px 12px"
  status-success:
    backgroundColor: "{colors.success-bg}"
    textColor: "{colors.success}"
    rounded: "{rounded.sm}"
    padding: "5px 9px"
  status-warning:
    backgroundColor: "{colors.warning-bg}"
    textColor: "{colors.warning}"
    rounded: "{rounded.sm}"
    padding: "5px 9px"
  status-danger:
    backgroundColor: "{colors.danger-bg}"
    textColor: "{colors.danger}"
    rounded: "{rounded.sm}"
    padding: "5px 9px"
---

# Design System: LaundryTwin Operations Workspace

## Overview

**Creative North Star: "The Calm Operations Room"**

LaundryTwin is an operational interface for people making decisions under real branch conditions. The visual world is restrained, evidence-first, and calm: a cool canvas, white work surfaces, navy-teal action color, and clear semantic status states. The interface should feel trustworthy enough for an owner or technician to use quickly, without implying that a cloud estimate is a safety system or that a visual status is more certain than its source.

Density is intentional. Desktop views support scanning across branches, machines, KPIs, and alerts; mobile LINE LIFF views preserve the same hierarchy with fewer columns and larger touch targets. HeroUI v3 supplies accessible interaction primitives while the local token layer controls the LaundryTwin visual language.

**Key Characteristics:**
- Calm navy, teal, and cool-neutral surfaces
- High information density with clear operational hierarchy
- Source, demo, freshness, unknown, stale, and unavailable states stay visible
- One Thai-capable sans system, with monospace reserved for identifiers and measurements
- No emoji as primary navigation or KPI iconography

## Colors

The palette is a quiet operational neutral field with one recurring teal action color and semantic status colors reserved for meaning.

### Primary
- **Deep Teal Navy** (`#123b40`): dark branded panels, primary text contrast, and selected navigation text.
- **LaundryTwin Teal** (`#0f6269`): primary actions, active controls, and brand accents.

### Neutral
- **Operations Canvas** (`#f4f7f6`): application background.
- **Work Surface** (`#ffffff`): cards, forms, navigation, and primary content panels.
- **Quiet Surface** (`#edf4f2`): secondary controls, muted panels, and quiet metadata.
- **Operational Ink** (`#12353a`): headings, labels, and primary values.
- **Supporting Ink** (`#4e686b`): body copy and secondary controls.
- **Metadata Gray** (`#829496`): timestamps, counts, and supporting details.
- **Hairline Border** (`#d7e3e0`): normal card and control boundaries.
- **Strong Border** (`#b8ccca`): focus, selected, and stronger control boundaries.

### Semantic
- **Healthy Green** (`#087a5b` with `#e5f6ee`): running, healthy, acknowledged, and fresh states.
- **Warning Amber** (`#9a5a00` with `#fff4d6`): stale, pending, or attention states.
- **Critical Red** (`#b42318` with `#fdecea`): unavailable, invalid, or error states.
- **Informational Blue** (`#2166a8` with `#eaf2fb`): source and system context.

**The One Accent Rule.** Teal marks action, selection, and identity. It is not decoration and does not compete with semantic status colors.

## Typography

**Display Font:** Noto Sans Thai, Avenir Next, Helvetica Neue, system-ui, sans-serif
**Body Font:** Noto Sans Thai, Avenir Next, Helvetica Neue, system-ui, sans-serif
**Data Font:** ui-monospace, SFMono-Regular, Menlo, monospace

**Character:** One familiar sans family keeps operational labels, Thai copy, controls, and data coherent. Monospace is a measurement layer for machine IDs, timestamps, codes, and telemetry values, not a costume for the whole interface.

### Hierarchy
- **Display** (800, `32px/1.12`, `-0.035em`): page title and primary workspace heading; mobile uses `26px`.
- **Headline** (800, `19px`): section and card-group titles.
- **Title** (800, `15–16px`): branch, machine, alert, and form-card titles.
- **Body** (400, `14px/1.6`): explanatory copy and operational descriptions; keep prose near `65–75ch` where it is narrative.
- **Label** (700, `12px`): field labels, metadata, navigation, and button text.
- **Data** (700, `11px`, monospace): IDs, timestamps, counts, and machine measurements.

**The Measurement Rule.** Use monospace only where the user compares, scans, or copies a value. Do not set entire labels, paragraphs, or navigation in monospace.

## Layout

The application uses a responsive content frame with a `24px` desktop gutter, `16px` mobile gutter, and a `1280px` maximum width. The top navigation is `72px` high on desktop and `64px` on mobile. The application shell is sticky, while page content provides the main scroll context.

Page sections use a `24px` rhythm. KPI grids collapse from four columns to two at tablet widths; they remain two columns on larger mobile viewports and become one column at `420px`. Branch and machine grids use two columns on tablet and one column on mobile. Dashboard/Twin switching uses HeroUI `Tabs` and preserves separate operational meanings for the business overview and Digital Twin.

Public login and legal pages use their own centered canvas and do not inherit the authenticated operations shell. LINE LIFF and desktop browser layouts must expose the same source, freshness, and uncertainty states.

## Elevation & Depth

The system is primarily tonal and bordered, with ambient shadows reserved for surfaces that need separation from the canvas. Flat cards are the default; shadows indicate physical grouping, sticky navigation, or a focused interaction rather than decoration.

### Shadow Vocabulary
- **Surface Ambient** (`0 1px 2px rgb(18 59 64 / 4%), 0 8px 24px rgb(18 59 64 / 4%)`): normal cards and content groups.
- **Brand Panel Lift** (`0 14px 32px rgb(18 59 64 / 16%)`): dark overview headers and prominent workspace panels.
- **Sticky Navigation Blur** (`backdrop-filter: blur(18px)`): top navigation separation from scrolling content.
- **Popover Lift** (`0 18px 38px rgb(18 59 64 / 14%)`): mobile navigation and overlays.

**The Flat-By-Default Rule.** Do not add a shadow to every card. Use borders and tonal surfaces for ordinary grouping; add depth only for hierarchy, overlay, or interaction state.

## Shapes

Corners are gently rounded and consistent: `8px` for small controls, `10px` for controls and navigation, `14px` for cards, and `18px` for public panels. Pill shapes are reserved for compact status and source labels. Borders are thin, cool, and explicit; avoid thick colored borders and hard offset shadows.

The `LT` typographic mark is the current brand symbol. It is a typographic placeholder until a standalone logo asset is approved; it must remain consistent in the authenticated shell and public login.

## Components

HeroUI v3 provides the interaction primitives. Local CSS tokens supply the LaundryTwin surface treatment and layout behavior.

### Buttons
- **Shape:** `10px` radius and `44px` minimum height.
- **Primary:** Teal background, white text, `0 16px` horizontal padding; used for the single primary action in a flow.
- **Secondary:** Quiet surface, navy text, and visible border; used for adjacent actions.
- **Outline:** White surface, navy text, and strong border; used for LINE login and secondary entry points.
- **Hover / Focus:** `160ms` state transitions, full-surface focus outline, no layout shift. HeroUI `isDisabled` and `isPending` provide disabled/loading semantics.

### Tabs and View Switching
- **Style:** HeroUI `Tabs` with `ListContainer`, `List`, `Tab`, `Indicator`, and `Panel` composition.
- **Dashboard:** “ภาพรวม” and “Digital Twin” are separate views with explicit panel IDs.
- **State:** Selected tab uses a white surface and navy text; inactive tabs use the dark panel's low-emphasis surface.
- **Responsive:** The tab group spans the available mobile content width and preserves a large touch target.

### Cards / Containers
- **Corner Style:** `14px` radius for operational cards; `18px` for public cards.
- **Background:** Work surface for content; quiet surface for nested or secondary groups; deep teal navy for overview headers.
- **Border:** `1px` hairline border on light surfaces.
- **Internal Padding:** `18–20px` for cards, `12–16px` for compact machine and branch facts.

### Machine Floor
- **Style:** A verified schematic floor grouped by branch, then washer/dryer, using machine cards and an inline SVG drum. It is not a photographic view or an invented coordinate map.
- **Machine identity:** Show the verified machine code, type, branch, status, last active time, and source context.
- **Cycles:** Show the count for the selected range only when it comes from authoritative machine-session evidence. Show `—` and an explicit unavailable label when that evidence is missing.
- **States:** Keep unknown, stale, unavailable, and running states distinct; a missing or unreadable state must never become “idle.”
- **Layout:** Branch groups are structural and responsive; the grid grows downward as the fleet grows.

### Inputs / Fields
- **Style:** HeroUI `TextField`, `Label`, `Input`, and `TextArea` composed inside `Form` where appropriate.
- **Branch Selection:** HeroUI `Select` with `ListBox`, explicit labels, and a strong trigger border.
- **Focus:** Brand outline with a soft teal focus ring; labels remain visible and associated.
- **Error / Disabled:** Error copy names the problem and recovery; unavailable fields remain visibly disabled rather than disappearing.

### Status and Source Labels
- **Status:** Compact semantic pills use text plus color. Running/fresh/acknowledged use green; stale/pending/paid use amber; unavailable/error use red; unknown/idle uses neutral.
- **Source:** Informational blue pill distinguishes ClickHouse, IRIS, demo, or other data source from operational status.
- **Freshness:** Stale and unavailable states must remain textually explicit and must not be replaced with a healthier-looking color.

### Navigation
- **Style:** Sticky white top bar with `LT` mark, LaundryTwin wordmark, “Operations workspace” context, and inline SVG icons.
- **Desktop:** Horizontal navigation with active quiet-teal background and border.
- **Mobile:** Compact menu control opens a contained navigation panel; sign-out uses a logout icon and does not duplicate admin navigation.
- **Public:** Login, Privacy, and Terms render outside the authenticated operations shell.

## Do's and Don'ts

### Do:
- **Do** use the deep teal navy and teal tokens for brand surfaces, actions, and selected states.
- **Do** keep source, demo, freshness, range, and uncertainty visible next to operational data.
- **Do** use HeroUI components for accessible interaction primitives and custom tokens for the local visual layer.
- **Do** pair status color with explicit Thai or English status text.
- **Do** use the `LT` mark and the canonical `LaundryTwin` name until a brand asset is approved.
- **Do** keep desktop layouts dense but scan-friendly and mobile layouts structurally collapsed.

### Don't:
- **Don't** use emoji as primary navigation, KPI, status, or machine iconography.
- **Don't** use teal as decoration on every surface or add saturated color to inactive controls.
- **Don't** add thick colored card borders, hard offset shadows, glass decoration, or page-load choreography.
- **Don't** hide missing, stale, unknown, offline, or unavailable states to make a dashboard look complete.
- **Don't** make cloud-derived machine state look like a physical safety system or imply machine commands.
- **Don't** use custom control shapes that bypass HeroUI semantics when an accessible HeroUI primitive fits.
