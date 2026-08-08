# Appraisal Map

Appraisal Map is a map-first workspace for locating, reviewing, and maintaining property appraisal records. It gives authorized teams a single geographic view of appraisal activity and the documents associated with each property.

The application is designed for company-operated environments. This repository contains the product source; it does not provide public access to company systems, data, or infrastructure.

## Overview

Appraisal Map brings the core appraisal workflow into one focused interface:

- Explore appraisal records on an interactive, clustered map.
- Set a clearly labelled subject property with location autocomplete.
- Review a synchronized nearby-report list with factual radius, property-type, and reference-date filters.
- Select up to three candidate reports and compare distance, dates, type, reported living area, and year built without rankings or automated appraisal conclusions.
- Review property details, report dates, photos, and supporting documents.
- Add, update, and reversibly archive records without leaving the map.
- Upload a single report or preserve a related document set as one archive.
- Restrict application access to authenticated users.

Map queries are scoped to the visible region and records are loaded in pages, keeping navigation responsive as the dataset grows. Protected files are requested only when needed and accessed through time-limited links.

## Technology

The client is built with React and integrates Google Maps for the primary workspace. Authentication, structured data, and protected file storage are provided by Supabase. The sign-in screen has no third-party map or font requests, so it stays fast and private before authentication.

## Development

### Prerequisites

- A current Node.js LTS release with npm
- Access to an authorized development environment
- Provisioned mapping and backend services

Install dependencies and start the local development server:

```bash
npm ci
npm start
```

Useful checks:

```bash
npm run lint
npm run test:ci
npm run build
```

### Launching from PyCharm

1. Open this repository as the PyCharm project.
2. In **Settings → Languages & Frameworks → Node.js**, select a Node.js 22 LTS interpreter and its bundled npm installation.
3. Open PyCharm's terminal and run `npm ci` once.
4. Copy `.env.example` to a local `.env.local` file and add development values from the approved secrets channel. Never use a Supabase service-role key in this browser application.
5. Open **Run → Edit Configurations**, add an **npm** configuration, select this repository's `package.json`, choose the `run` command, and enter `start` as the script.
6. Run that configuration and open [http://localhost:3000](http://localhost:3000).

Required local configuration keys:

```dotenv
REACT_APP_SUPABASE_URL=
REACT_APP_SUPABASE_ANON_KEY=
REACT_APP_GOOGLE_MAPS_API_KEY=
```

Optional sign-in help link:

```dotenv
REACT_APP_SUPPORT_EMAIL=administrator@example.com
```

The map defaults to an enforced Southern Ontario service area. Operators can change its label,
version, mode (`enforced` or `advisory`), and bounds with the optional
`REACT_APP_SERVICE_AREA_*` values documented in `.env.example`. Leave them unset to use the safe
defaults.

The Google Maps browser key should be restricted to the authorized local and deployed origins. The Supabase anon key is a public client credential and must be protected by Row Level Security and private storage-bucket policies.

If a required value is missing or malformed, the app shows a setup message instead of a blank screen. Restart `npm start` after changing a local environment file.

### Production setup checklist

1. Add the three required `REACT_APP_*` values to the production and preview environments in Vercel, then redeploy. Add `REACT_APP_SUPPORT_EMAIL` if staff should have a direct help link.
2. Restrict the Google Maps browser key to the deployed hostname and the Maps JavaScript API, Places API, and Geocoding API used by this app.
3. Apply the migrations in `supabase/migrations` in filename order through the authorized Supabase workflow. They are additive and do not delete or rewrite existing reports.
4. Confirm Row Level Security on `appraisals` and private policies for `photos`, `pdfs`, and `appraisal-folders` with separate reader and editor test accounts. Follow the exact inspection checklist in `supabase/README.md`; existing policy names must be reviewed before replacement.
5. Assign write access through server-controlled `app_metadata.role` before deploying this client. Supported writer values are `admin`, `editor`, `writer`, and `appraiser`; missing or unknown roles are intentionally view-only.
6. Add `REACT_APP_SUPABASE_URL` and `REACT_APP_SUPABASE_ANON_KEY` as GitHub Actions secrets so the existing **Keep Supabase Alive** workflow can make its read-only probe.
7. Enable GitHub private vulnerability reporting so the process in `SECURITY.md` has a confidential destination.

The browser bundle must receive only the Supabase anon/publishable key. Never add the service-role key to `.env`, Vercel, or GitHub secrets used by the client or keep-alive workflow.

### Database rollout

The SQL files in `supabase/migrations` add comparison fields, normalized addresses, idempotent
creates, optimistic versions, reversible archiving, and metadata-only auditing. Apply them in
filename order before enabling the matching features for staff. The client continues to read,
create, and edit against the legacy schema while rollout is pending. Archiving deliberately stays
disabled until the safety migration exists, so it never falls back to permanent deletion.

### Configuration

Runtime configuration is intentionally kept outside this repository. Maintainers provide development credentials and service configuration through the company-approved secrets channel.

Do not commit credentials, privileged service keys, production identifiers, customer records, or copies of production files. Local development should use isolated resources and non-sensitive test data.

## Security

Appraisal records and their attachments may contain confidential information. Changes must preserve the following boundaries:

- Authentication in the client controls the user experience; authorization must be enforced by backend access policies.
- UI role visibility uses only server-controlled `app_metadata`; it is not a substitute for Row Level Security.
- Data and storage access should follow least-privilege rules for authenticated users.
- Protected files should remain private and be served through short-lived access URLs.
- Browser-delivered credentials must be publishable, appropriately restricted, and safe to expose to an untrusted client. Privileged keys must never be included in a client build.
- Production configuration and data must not be used for local development or automated tests.

If you discover a vulnerability, do not open a public issue with exploit details, credentials, or customer data. Report it privately to the repository maintainers through an approved company channel.

## Contributing

Keep changes focused, reviewable, and free of operational or customer-specific information. Before opening a pull request:

1. Run the test suite and create a production build.
2. Confirm that no secrets, generated artifacts, or sensitive data were added.
3. Describe the user impact and any security implications.
4. Include tests for behavior that can be covered reliably.

Deployment, infrastructure changes, and production access are managed by authorized maintainers outside the public documentation.
