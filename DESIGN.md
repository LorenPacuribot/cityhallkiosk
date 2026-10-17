---
name: Malaybalay City Hall kiosk
description: Responsive civic wayfinding across the public kiosk.
colors:
  header-deep: "#16395d"
  header-blue: "#1b5ca5"
  civic-navy: "#16395d"
  cool-canvas: "#f4f6f8"
  card-white: "#ffffff"
  warm-border: "#d8dfe6"
  pale-blue: "#eaf1f8"
  focus-amber: "#a35d00"
typography:
  headline:
    fontFamily: "Plus Jakarta Sans, sans-serif"
    fontSize: "clamp(28px, 2.3vw, 40px)"
    fontWeight: 700
    lineHeight: 1.2
    letterSpacing: "-0.025em"
  title:
    fontFamily: "Plus Jakarta Sans, sans-serif"
    fontSize: "clamp(23px, 1.7vw, 30px)"
  body:
    fontFamily: "Plus Jakarta Sans, sans-serif"
    fontSize: "clamp(18px, 1.25vw, 23px)"
  detail-label:
    fontFamily: "Plus Jakarta Sans, sans-serif"
    fontSize: "clamp(18px, 1.25vw, 23px)"
    fontWeight: 600
rounded:
  card: "16px"
  button: "10px"
  requirement: "4px"
spacing:
  small: "16px"
  group: "24px"
  columns: "clamp(24px, 2.3vw, 40px)"
  page-inset: "clamp(24px, 4vw, 80px)"
components:
  button-primary:
    textColor: "{colors.card-white}"
    rounded: "{rounded.button}"
    height: "52px"
  card:
    backgroundColor: "{colors.card-white}"
    rounded: "{rounded.card}"
  requirement:
    backgroundColor: "{colors.card-white}"
    padding: "16px 0"
---

# Design System: Malaybalay City Hall kiosk

## Overview

**Creative North Star: "Civic wayfinding"**

The owner's references define the office and service detail composition. The subsequent deployment-readiness request extends one consistent visual system across the kiosk, with calmer typography and more space at laptop widths.

`server/public/kiosk/kiosk.css` is the implementation source. The screen uses real viewport pixels, without scaling a 1920px canvas. Phone handoff and admin retain their own layouts.

**Key Characteristics:**
- Navy-to-blue gradient page bands with the City Hall render faded in from the right (one global header), and blue primary actions.
- Readable information with responsive typography and space.
- Fine borders, white surfaces and the supplied subdued pattern.
- Visible destination and take-away actions.

## Colors

### Primary

Header Deep and Header Blue form the gradient of every page band, with the City Hall render at 30% opacity masked in from the right (owner's request, 2026-10-17). Header Blue supplies primary actions. Civic Navy anchors headings. The cover uses the full photo with a navy fade from the left to keep its text readable.

### Neutral

Cool Canvas surrounds Card White surfaces. The border token retains its legacy name but now has the cool neutral value used by the shared 1px borders. Pale Blue groups icons and sequence markers. Focus Amber marks keyboard focus with a 3px outline and 3px offset.

**The Scope Rule.** Reuse this system across the public kiosk. Keep phone and admin changes scoped to their own workflows.

## Typography

Retain the self-hosted Plus Jakarta Sans family. Service sections use the title role; office values, requirements and process actions use the detail-label role. Home display text ranges from 36 to 52px. Preserve wrapping for official text and translations.

Larger text raises body text to 22–29px and page headings to 34–48px. Short and narrow viewports scroll the whole page so headers and action docks cannot consume the reading area. Do not use fixed-height clipping.

## Layout

The landscape office page has facts and directions on the left, services on the right, in a 0.8:1.2 proportion. Page gutters range from 24 to 80px (20px on phones). Columns use the shared responsive gap. Cards remain separate touch targets.

The service page presents fee, time and eligibility, followed by requirements and process columns in a 0.9:1.1 proportion with 24px separation. Requirements, feedback and expandable source/context occupy the first column; complete process steps and notes occupy the second. Reading order is requirements, process, then support. Portrait stacks the content; narrow layouts stack summary cards.

The service dock shows destination, take-away and directions. Portrait puts the destination on its own line. Larger screens keep the dock visible; narrow or short/zoomed screens use a single scrolling reading flow. The navigation minimap lives beside the 3D view in landscape and below it in portrait. Playback controls lead the sidebar and stay reachable while scrolling.

## Elevation & Depth

Cards and actions use borders and tonal contrast without shadows. Modal sheets use `0 18px 48px #10233933` to distinguish the active layer. Avoid decorative depth on ordinary content.

## Shapes

Use the recorded card and button radii. Circular number markers distinguish section and step order; simple chevrons identify office/service rows. Requirement boxes are visual checklist markers, not interactive checkboxes.

## Components

- **Office information card:** grouped icon, label and value rows, opening status and directions.
- **Service row:** white bordered touch target with title, supporting text and blue chevron.
- **Summary card:** fee, time or eligibility label above its prominent value.
- **Requirement panel:** white panel with separated rows, visual checklist markers and source information.
- **Process step:** numbered blue circle, resident action, agency action and compact metadata.
- **Action dock:** destination plus take-away and primary directions buttons.

**The Evidence Rule.** Display official service text and genuine location status; visual polish must not imply that an unverified route or location has been checked.

## Do's and Don'ts

- Do preserve the screenshot-led office and service detail composition.
- Do preserve translations, larger text, scrolling and visible focus.
- Do keep Charter content and location status accurate.
- Do keep touch controls at least 44px high, keyboard focus visible, and modal focus contained.
- Don't truncate requirements or process text to fit a card.
- Don't invent office locations, routes or accessibility connections.

## Office directory

Browse offices is a separate floor-grouped directory using the civic detail chrome. Landscape uses two equal columns of office rows; portrait uses one. Each row opens the individual office page. Floor filters and Back preserve the browsing flow. This replaces the former landscape preview panel.

## Kiosk background

Owner-supplied bg.png is stored unchanged at server/public/img/kiosk-background.png. Kiosk screens use it centered with cover sizing and no repeat, at its original visibility without a white wash (owner reaffirmed 2026-10-17). Cards, bands and controls remain opaque. The premium City Hall image appears within the home page with the three direct visitor actions.
