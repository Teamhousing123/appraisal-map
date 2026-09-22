# Appraisal Map

Appraisal Map is an authenticated workspace for appraisal teams to find and review previously recorded property reports. It brings a map, report details, factual comparisons, and source documents into one workflow.

Nearby reports are research candidates. Appraisal Map does not select comparables, calculate property values, or replace an appraiser’s professional judgment.

## Capabilities

- Explore reports in the current map area with marker clustering and distance, property type, and date filters.
- Search for an address, confirm its location, and review nearby records.
- Compare up to three records using available facts such as distance, dates, property type, living area, and year built.
- Add and update records, and archive them with a reversible workflow when authorized.
- Attach photos, PDFs, or related document sets; larger uploads can resume after interruption.

## How it works

The React client uses Google Maps Platform for the map, Places address search, and geocoding. Supabase provides authentication, Postgres/PostgREST for appraisal records, and Storage for source files. Map queries are bounded to the viewed area and paginated. Comparison distance is straight-line distance; it is not a travel distance or a valuation adjustment.

The application is configured for a Southern Ontario service area. Records and uploaded source documents are supplied by the appraisal team; this repository does not include a public listing feed or a sample property dataset. Available property facts and dates depend on what staff recorded in the source reports.

## Security and privacy

- The frontend uses a Supabase URL and anon key. These are client configuration values, not administrative secrets; database access must remain protected by Row Level Security.
- Never put a Supabase `service_role` key or other server secret in a `REACT_APP_*` variable or browser bundle.
- App roles are read from server-controlled `app_metadata`; unrecognized roles default to read-only in the client. Database policies remain the security boundary.
- Storage bucket privacy and object policies are configured separately from database row policies. Verify the deployed photo, PDF, and appraisal-document buckets are private and have the intended read, upload, and delete rules.
- Restrict the Google Maps browser key by allowed referrers and enabled APIs in Google Cloud Console. Do not commit `.env` or production credentials.
- Do not put real appraisal records, addresses, or source documents in screenshots, issue reports, or public examples.

## Local development

Requirements: Node.js and npm.

1. Install dependencies with `npm ci`.
2. Copy `.env.example` to `.env` and configure `REACT_APP_SUPABASE_URL`, `REACT_APP_SUPABASE_ANON_KEY`, and `REACT_APP_GOOGLE_MAPS_API_KEY` for a non-production environment.
3. Start the development server with `npm start`.

The app runs at `http://localhost:3000`. Use test accounts and non-production data during development.

## Checks

- `npm run lint` — ESLint checks for `src`.
- `npm run test:ci` — runs the Jest suite once.
- `npm run build` — creates the production bundle.
- `npm run verify:build` — checks the generated build output.
- `npm audit --audit-level=high` — checks installed dependencies for high or critical advisories.

## License and data rights

Copyright © 2026 Teamhousing123. All rights reserved. This repository is proprietary; public visibility does not grant permission to use, copy, modify, or distribute its code without separate written permission. Google Maps Platform, Supabase, and any source appraisal documents or data are subject to their respective owners’ terms and rights.
