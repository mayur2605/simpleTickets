# SimpleTickets UI direction

Status: revised interactive prototype after feedback that the first version looked basic. 16 September 2026.

## Design decision

A light IT workspace with silver navigation, burnt-orange actions and labeled semantic status colors. Prioritize readable ticket subjects, clear ownership, response deadlines and quick replies. Use restrained motion and compact spacing; no marketing hero, stock imagery or decorative charts.

- Prototype implementation: React + TypeScript + Vite.
- Components: official Fluent UI React v9, with its theme and accessible controls.
- Icons: Fluent UI icon family.
- Typography: locally bundled Geist, with Segoe UI / sans-serif fallback.
- Surfaces: #F7F7F5 workspace, #FFFFFF panels, light silver navigation.
- Actions: #B54720 burnt orange. Status colors communicate meaning and always include text.
- Shape: 8 px panels, 4–6 px controls and labels.
- Mobile: horizontal navigation, two-column summaries, horizontally scrollable ticket table, stacked ticket details.

Taste Skill was consulted at the user's request. Its current instructions explicitly exclude dashboards and recommend an established product UI system such as Fluent. This prototype uses that recommendation rather than applying landing-page styling to a support tool.

## Included interactions

All Tickets and My Tickets navigation, a Needs attention queue filter, search, status filtering and empty state; ticket conversation; owner and priority selection; editable ready-made replies with send-time status changes; private internal notes; admin template creation/editing; sample team workload with a persistent desktop side panel.

## Deliberate prototype limitations

All data is fictional and held in browser memory. Refresh resets changes. There is no authentication, API, database, email delivery, SLA scheduler, attachment handling, backup job or permission enforcement yet. The admin identity is fixed for layout review. Team availability controls are not implemented. Dates and due labels are sample content, not a running clock. Other PRD filters and full lifecycle rules remain implementation tasks. This is not the production ticketing system.

The UI prototype does not finalize the backend hosting choice. Cloudflare and Zimbra feasibility checks remain pending.

## Run and verify

From `prototype/`:

```sh
npm ci
npm run dev -- --port 5173
npm run build
# With Google Chrome installed; tests start their own server on 5174:
npm run verify
```

Open http://127.0.0.1:5173 to review.

## Updated design constraints

Apply the user's frontend rules in dashboard context: SimpleTickets is the main workspace heading; avoid decorative promotional panels, unnecessary cards and competing metadata. Keep the ticket queue as the main visual anchor. Use locally bundled Geist and named CSS tokens, a subtle patterned workspace, and functional focus/hover transitions with reduced-motion support. Landing-page hero and imagery requirements do not apply to this operational dashboard. Retain official Fluent UI controls.

## Current palette supersedes earlier iterations

See [brand foundation](brand.md). Burnt orange, pearl, graphite and silver replace the previous navy/blue direction. Allcheck is removed from app branding. The support mailbox and approved sender domain remain unchanged.
