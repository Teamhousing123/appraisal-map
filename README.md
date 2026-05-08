# Appraisal Map

An internal tool for viewing and managing property appraisals on an interactive map. Staff can search locations, add new appraisals with photos and documents, and access reports by clicking map pins.

## Features

- Interactive map centered on southern Ontario with search and autocomplete
- Add appraisals with address, house photo, and a folder of documents (PDFs, images, etc.)
- Click a map pin to view the house photo, address, and download associated files
- Edit or delete existing appraisals directly from the map
- Login-protected — only authorized staff can access data
- All files stored in private cloud storage with signed URLs

## Tech Stack

- **Frontend:** React, Leaflet.js (via react-leaflet), CARTO Voyager map tiles
- **Backend/Database:** Supabase (PostgreSQL with Row Level Security)
- **File Storage:** Supabase Storage (private buckets)
- **Authentication:** Supabase Auth (email/password)
- **Geocoding:** OpenStreetMap Nominatim API
- **Hosting:** Vercel

## Project Structure

```
src/
  supabaseClient.js   - Supabase connection config
  App.js              - Auth routing (login vs map)
  Login.js            - Login page with map background
  Map.js              - Main map view, search, popups, edit/delete
  AddAppraisal.js     - Form for adding new appraisals
```

## Setup

### Prerequisites

- Node.js installed
- A Supabase project with:
  - An `appraisals` table (address, city, latitude, longitude, photo_url, folder_files)
  - Row Level Security enabled with policies for authenticated users
  - Storage buckets: `photos`, `appraisal-folders` (both private)
  - User accounts created manually in Supabase Auth

### Install and Run

```bash
git clone https://github.com/YOUR_USERNAME/appraisal-map.git
cd appraisal-map
npm install
```

Create a `.env` file in the project root:

```
REACT_APP_SUPABASE_URL=your_supabase_project_url
REACT_APP_SUPABASE_ANON_KEY=your_supabase_publishable_key
```

Start the development server:

```bash
npm start
```

### Deploy

The project is hosted on Vercel. Pushing to `main` triggers an automatic deploy. Environment variables are configured in the Vercel dashboard.

## Database Schema

```sql
CREATE TABLE appraisals (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  address TEXT NOT NULL,
  city TEXT NOT NULL,
  latitude DOUBLE PRECISION NOT NULL,
  longitude DOUBLE PRECISION NOT NULL,
  photo_url TEXT,
  folder_files TEXT[],
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
```

## Security

- Row Level Security restricts all database access to authenticated users
- Storage buckets are private with access policies for authenticated users only
- File access uses signed URLs that expire after 1 hour
- No public signup — user accounts are created manually in Supabase
- Environment variables are excluded from version control via .gitignore

## Adding an Appraisal

1. Log in with your staff credentials
2. Click the "+ Add" button in the top navigation
3. Enter the property address and city
4. Upload a house photo
5. Select the appraisal folder containing all related documents
6. Click "Save Appraisal" — the address is geocoded automatically and a pin appears on the map

## Editing or Deleting

Click any pin on the map, then use the "Edit" or "Delete" buttons in the popup. Editing allows you to change the address, replace the photo, or replace the document folder. Deleting requires a confirmation click.
