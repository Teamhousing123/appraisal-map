# Appraisal Map

Appraisal Map is a map-based workspace built for appraisal teams. It keeps past reports, property details, photos, and supporting documents in one place so appraisers can find relevant work without digging through folders or disconnected systems.

Appraisers can search for a subject property, see nearby reports, compare recorded property facts, and open the original documents for full context. The map keeps the location, report list, and selected subject in sync so the information on screen always relates to the area being reviewed.

## What it does

- Displays appraisal reports on an interactive Google Map with marker clustering.
- Searches addresses and moves directly to the selected subject property.
- Shows reports in the visible map area or within a selected distance.
- Filters reports by distance, property type, and reference date.
- Compares up to three candidate reports using factual information such as distance, dates, property type, living area, and year built.
- Opens original appraisal PDFs, photos, and related supporting files.
- Lets authorized users add, update, and archive report records from the map.
- Supports both single-report uploads and related document sets.

## Built for appraisal work

Nearby reports are starting points for research, not automatically selected comparables. Appraisal Map keeps the original report available and presents recorded facts without rankings or automated valuation conclusions, leaving selection and interpretation to the appraiser.

Records load according to the current map area, protected files open only when requested, and filters remain optional until they are useful.

## Technology

Appraisal Map is built with React, Google Maps Platform, and Supabase. Google Maps provides the geographic workspace, while Supabase handles authentication, structured report data, and protected file storage.
