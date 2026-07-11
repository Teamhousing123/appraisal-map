# Appraisal Map

Appraisal Map is a map-first workspace for locating, reviewing, and maintaining property appraisal records. It gives authorized teams a single geographic view of appraisal activity and the documents associated with each property.

The application is designed for company-operated environments. This repository contains the product source; it does not provide public access to company systems, data, or infrastructure.

## Overview

Appraisal Map brings the core appraisal workflow into one focused interface:

- Explore appraisal records on an interactive, clustered map.
- Search for an address, city, or area with location autocomplete.
- Review property details, report dates, photos, and supporting documents.
- Add, update, and remove records without leaving the map.
- Upload a single report or preserve a related document set as one archive.
- Restrict application access to authenticated users.

Map queries are scoped to the visible region and records are loaded in pages, keeping navigation responsive as the dataset grows. Protected files are requested only when needed and accessed through time-limited links.

## Technology

The client is built with React and integrates Google Maps for the primary workspace. Authentication, structured data, and protected file storage are provided by Supabase. The sign-in experience uses Leaflet with CARTO basemaps.

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
npm test -- --watchAll=false
npm run build
```

### Configuration

Runtime configuration is intentionally kept outside this repository. Maintainers provide development credentials and service configuration through the company-approved secrets channel.

Do not commit credentials, privileged service keys, production identifiers, customer records, or copies of production files. Local development should use isolated resources and non-sensitive test data.

## Security

Appraisal records and their attachments may contain confidential information. Changes must preserve the following boundaries:

- Authentication in the client controls the user experience; authorization must be enforced by backend access policies.
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
