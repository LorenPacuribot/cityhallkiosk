---
name: Malaybalay City Hall detail screens
description: Screenshot-led civic styling scoped to office and service details.
colors:
  header-deep: "#0c2340"
  header-blue: "#307dd7"
  civic-navy: "#13385f"
  cool-canvas: "#f3f7fc"
  card-white: "#ffffff"
  warm-border: "#e3ddd3"
  pale-blue: "#e3eefc"
  focus-amber: "#b36b00"
typography:
  headline:
    fontFamily: "Plus Jakarta Sans, sans-serif"
    fontSize: "60px"
    fontWeight: 700
    lineHeight: 1.1
    letterSpacing: "-0.025em"
  title:
    fontFamily: "Plus Jakarta Sans, sans-serif"
    fontSize: "36px"
  body:
    fontFamily: "Plus Jakarta Sans, sans-serif"
    fontSize: "28px"
  detail-label:
    fontFamily: "Plus Jakarta Sans, sans-serif"
    fontSize: "30px"
    fontWeight: 700
rounded:
  card: "26px"
  button: "24px"
  requirement: "20px"
spacing:
  small: "20px"
  group: "24px"
  columns: "32px"
  page-inset: "64px"
components:
  button-primary:
    textColor: "{colors.card-white}"
    rounded: "{rounded.button}"
    height: "104px"
  card:
    backgroundColor: "{colors.card-white}"
    rounded: "{rounded.card}"
  requirement:
    backgroundColor: "{colors.pale-blue}"
    rounded: "{rounded.requirement}"
    padding: "20px 22px"
---

# Design System: Malaybalay City Hall detail screens

## Overview

**Creative North Star: "Civic wayfinding"**

The owner's pinned screenshots define the office and service detail composition. A blue header band, cool canvas and generously rounded white cards make official information approachable and easy to scan at a public touchscreen.

This is a scoped implementation record, not a global identity replacement. Apply it only to the office and service detail screens marked `civic-detail` in `server/public/kiosk/app.js`. The final reference-design block in `server/public/kiosk/kiosk.css` is the implementation source. Other screens keep their existing design.

**Key Characteristics:**
- Blue gradient header and primary actions.
- Large, readable information blocks.
- Warm borders against a cool canvas.
- Visible destination and take-away actions.

## Colors

### Primary

Header Deep and Header Blue form the header gradient (115 degrees, blue stop at 85%). Civic Navy anchors headings and controls. Primary buttons use the implemented action gradient (145 degrees, #307fda to #12365b at 80%); these action endpoints are not substitutes for the header endpoints.

### Neutral

Cool Canvas surrounds Card White surfaces. Warm Border outlines cards and rows (2px). Pale Blue groups requirements, number markers and process metadata. Focus Amber marks keyboard focus (4px outline, 4px offset).

**The Scope Rule.** Keep these visual overrides inside the two detail screens; do not restyle the welcome, home, browse, map, navigation, phone or admin screens.

## Typography

Retain the existing Plus Jakarta Sans family. The frontmatter headline records the landscape heading; portrait inherits the app's heading scale. Service section titles use the title role; office values, requirements and process actions use the detail-label role. Preserve wrapping for official text and translations.

Larger text raises detail values and requirement/process labels to 36px and summary values to 40px. Do not replace this behavior with fixed-height clipping.

## Layout

The landscape office page has a header above two columns: office facts and directions on the left, services on the right. Columns use a 760:992 proportion, 40px gap and 64px horizontal inset. Cards remain separate touch targets.

The service page presents fee, processing time and eligibility summaries, followed by requirements and process columns. Landscape uses equal columns with a 32px gap. Requirements, feedback and source/context occupy the first column; numbered process steps and notes occupy the second. Portrait stacks these columns. Narrow layouts stack summary cards.

The bottom service dock shows destination, take-away and directions actions. Portrait places destination on its own line. Keep content scrollable independently of persistent actions.

## Elevation & Depth

Cards use borders and tonal contrast for structure. The primary action alone has a soft lift (`0 12px 24px #15395e26`); the service dock has no shadow. Preserve the header's tonal depth without adding decorative layers.

## Shapes

Use the recorded card, button and requirement radii. Circular number markers distinguish section and step order; circular arrow affordances identify office service rows. Requirement boxes are visual checklist markers, not interactive checkboxes.

## Components

- **Office information card:** grouped icon, label and value rows, opening status and directions.
- **Service row:** generous white bordered touch target with title, supporting text and circular blue arrow.
- **Summary card:** fee, time or eligibility label above its prominent value.
- **Requirement panel:** pale-blue inset row with visible checklist marker and source information.
- **Process step:** numbered blue circle, resident action, agency action and compact metadata.
- **Action dock:** destination plus take-away and primary directions buttons.

**The Evidence Rule.** Display official service text and genuine location status; visual polish must not imply that an unverified route or location has been checked.

## Do's and Don'ts

- Do preserve the screenshot-led office and service detail composition.
- Do preserve translations, larger text, scrolling and visible focus.
- Do keep Charter content and location status accurate.
- Don't extend this scoped redesign to other app screens.
- Don't truncate requirements or process text to fit a card.
- Don't invent office locations, routes or accessibility connections.

## Office directory

Browse offices is a separate floor-grouped directory using the civic detail chrome. Landscape uses two equal columns of office rows; portrait uses one. Each row opens the individual office page. Floor filters and Back preserve the browsing flow. This replaces the former landscape preview panel.
