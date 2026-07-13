# Minimal Traffic Signal Operator System

This folder contains a lightweight web app for traffic signal operator attendance and shift tracking.

## What it includes
- Mobile-friendly login screen
- Operator shift-in / shift-out workflow
- Admin dashboard with live duty overview
- Supabase-backed storage for profiles, intersections, shifts, and attendance

## Free stack
- Frontend hosting: GitHub Pages or Netlify
- Database/auth: Supabase (free tier)
- Maps: optional Leaflet later

## Setup steps
1. Create a Supabase project.
2. Run the SQL from schema.sql in the Supabase SQL editor.
3. Create a new user in Supabase Auth.
4. Insert a profile row manually with role='admin' and full_name='Administrator'.
5. Update config.js with your Supabase URL and anon key.
6. Deploy the site using GitHub Pages or Netlify.
