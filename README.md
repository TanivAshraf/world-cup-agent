This architectural blueprint serves as a system handbook. It outlines the core
design, pipeline logic, database schemas, and step-by-step replication guide so
that you or any AI agent can immediately build, adapt, or duplicate this system
for any other sport, league, or predictive domain in the future.

Architecture Blueprint: Fully Autonomous Search-Grounded Prediction System

This document provides a technical blueprint for an end-to-end, serverless,
self-sustaining predictive pipeline. The system operates on a zero-intervention
loop: autonomously syncing fixture schedules, executing predictions with
real-time web search grounding within specific time windows, scraping post-match
outcome statistics, and committing a public CSV database backup directly to
GitHub.

1. System Topology & Design Decisions

The platform is designed around a decoupled, serverless architecture to ensure
high reliability, complete cost-efficiency (100% free-tier compliant), and
security.

                  ┌──────────────────────────────┐
                  │   GitHub Actions Scheduler   │
                  │   (Triggers every 30 mins)   │
                  └──────────────┬───────────────┘
                                 │
            ┌────────────────────┴────────────────────┐
            ▼                                         ▼
┌───────────────────────┐                 ┌───────────────────────┐
│ Autonomous Syncer     │                 │ AI Prediction Engine  │
│ (Searches for newly   │                 │ (Triggers at T-2.5h)  │
│  confirmed fixtures)  │                 │                       │
└───────────┬───────────┘                 └───────────┬───────────┘
            │                                         │
            │ (Updates DB)                            │ (Queries Gemini + Web)
            ▼                                         ▼
┌─────────────────────────────────────────────────────────────────┐
│                     Supabase PostgreSQL DB                      │
│        (Matches, Predictions, and Ground Truth Tables)         │
└───────────┬─────────────────────────────────────────┬───────────┘
            │                                         │
            │ (Pulls for Backup)                      │ (Queries secure API)
            ▼                                         ▼
┌──────────────────────────┐              ┌──────────────────────────┐
│   GitHub CSV Exporter    │              │ Vercel Serverless API &  │
│ (wc_predictions_archive) │              │    HTML Live Dashboard   │
└──────────────────────────┘              └──────────────────────────┘

Key Architectural Decisions:

  - Vercel Backend Proxy (/api/data.js): Standard web applications often query
    databases directly from client-side JavaScript. This exposes public API keys
    in the browser, making them vulnerable to extraction. To resolve this, a
    backend serverless proxy was designed. The browser requests data from
    /api/data.js, which securely reads hidden environment variables on Vercel's
    servers, queries Supabase, and returns clean data back to the user.
  - GitHub Actions for Heavy Compute: Vercel's free hobby tier imposes a
    strict 10-second timeout on serverless functions. Because search-grounded
    LLM operations require crawling multiple search indices (news, lineups,
    social trends) and take between 15–20 seconds to complete, we shifted
    execution entirely to GitHub Actions. GitHub Action runners have a 6-hour
    execution limit, run completely in the background for free, and can commit
    updated CSV files back to the repository.
  - The T-2.5 Hour Window Logic: Operating on a 30-minute cron interval, the
    execution engine evaluates the difference between the current time and
    kickoff time. It targets matches starting in 2.5 hours or less—the precise
    moment when managers publish starting lineups. This ensures the AI model
    evaluates actual team sheets and late-stage warm-up developments rather than
    guessed lineups.

2. Directory Structure & File Responsibilities

To replicate this codebase, organize the repository with these 6 core files:

├── .github/
│   └── workflows/
│       └── schedule.yml     # GitHub Actions workflow (Automation & push tasks)
├── api/
│   └── data.js              # Vercel Serverless Function (Secure DB proxy)
├── predict.js               # Node.js script (Match syncing & T-2.5h predictions)
├── export.js                # Node.js script (Compiles DB data to CSV on runner)
├── package.json             # Project dependencies and startup scripts
└── index.html               # Frontend dashboard (Responsive UI with filters & cards)

3. Database Schema Blueprint (DDL)

Run this SQL query in your database manager to set up the clean, relational
storage model required for the system:

-- 1. Matches Table: Holds the scheduling log
CREATE TABLE matches (
    id SERIAL PRIMARY KEY,
    home_team TEXT NOT NULL,
    away_team TEXT NOT NULL,
    kickoff_time TIMESTAMPTZ NOT NULL,
    status TEXT DEFAULT 'Pending' -- 'Pending', 'Processing', 'Completed', 'Error'
);

-- 2. Predictions Table: Holds pre-match forecasts and search citation links
CREATE TABLE predictions (
    match_id INT PRIMARY KEY REFERENCES matches(id) ON DELETE CASCADE,
    predicted_winner TEXT,
    predicted_score TEXT,
    goalscorers JSONB,       -- Schema: [{"player": "Name", "minute": "45"}]
    assists JSONB,           -- Schema: [{"player": "Name", "minute": "45"}]
    bookings JSONB,          -- Schema: [{"player": "Name", "type": "Yellow/Red", "minute": "12"}]
    injuries JSONB,          -- Schema: [{"player": "Name", "minute": "70"}]
    clean_sheets JSONB,      -- Schema: {"home": true, "away": false}
    fantasy_tips TEXT,       -- Summary tips optimized for fantasy managers
    raw_analysis TEXT,       -- Structured, multi-paragraph tactical briefing
    grounding_sources JSONB, -- Stores exact citations and crawled URLs
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 3. Results Table: Stores actual match outcomes for post-game comparison
CREATE TABLE results (
    match_id INT PRIMARY KEY REFERENCES matches(id) ON DELETE CASCADE,
    actual_winner TEXT,
    actual_score TEXT,
    goalscorers JSONB,      -- Array of real goalscorers
    assists JSONB,          -- Array of real assists
    bookings JSONB,         -- Array of real bookings
    injuries JSONB,         -- Array of real injuries
    clean_sheets JSONB,      -- Object of real clean sheets: {"home": true, "away": false}
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

4. The Autonomous Engine Loop

Every 30 minutes, the GitHub Actions cron executes the system loop in this exact
sequence:

1.  Autonomous Schedule Sync: The runner checks the database matches table. If
    the number of pending matches falls below 3, the script triggers a
    Search-Grounded AI routine to crawl the web, identify newly confirmed
    matches (e.g., as knockout brackets are determined), and write them back
    into the database with a Pending status.
2.  Predictive Forecasting (T-2.5h Window): The script scans for matches
    starting within 2.5 hours. It queries the Gemini API with search grounding
    active to parse warm-up news, player lineups, and tactical trends. The
    resulting JSON prediction, along with the crawl citation URLs, is written
    directly to Supabase.
3.  Autonomous Outcome Syncing (T+3.5h Window): If a match was marked Completed
    (predicted) and 3.5 hours have elapsed since kickoff, the script searches
    the web for the official final scores, goalscorers, cards, and injuries, and
    writes them directly into the results table.
4.  CSV Compilation & Push: Finally, the script executes export.js to parse all
    database tables, convert complex arrays into clean, spreadsheet-friendly
    text columns, output a public wc_predictions_archive.csv file, and push it
    directly back to GitHub with a version-controlled commit log.

5. Security & Credentials Setup

To build this or any other predictor, you must save your environment variables
in these two interfaces:

A. Inside GitHub Settings (Repository Secrets):

  - SUPABASE_URL — Your Supabase project API endpoint.
  - SUPABASE_SERVICE_ROLE_KEY — Your private admin key. This key bypasses Row
    Level Security (RLS) policies, allowing your background script to safely
    write predictions, results, and schedules.
  - GEMINI_API_KEY — Your Gemini API Key from Google AI Studio.

B. Inside Vercel Settings (Environment Variables):

  - SUPABASE_URL — Your Supabase project API endpoint.
  - SUPABASE_ANON_KEY — Your public anon key. This key is used on the backend
    proxy serverless function to read the tables, keeping your keys hidden from
    public visitors.

6. Blueprint for Adapting to Other Predictor Domains

(Instructions for future AI agents or developer replication)

If you are cloning or adapting this system for another sport, tournament, or
predictive environment (e.g., Champions League, NFL, IPL, or even stock/weather
trends), modify these specific parameters inside your codebase:

1.  DB Schema adjustment: If your new domain does not use concepts like "clean
    sheets," "bookings," or "goalscorers," simply update the column structures
    in your SQL database to reflect your new metrics.
2.  predict.js - API Prompts:
      - Change the Google Search instructions in the prompts to target your new
        domain (e.g., change "Search for the lineup announcements for both World
        Cup teams" to "Search for active weather reports, pressure systems, and
        storm warnings").
      - Modify the requested JSON payload structure to match your newly designed
        database columns.
3.  export.js - CSV Mapping: Adjust the headers array and cell mapping to match
    your new table schema.
4.  index.html - Visual Dashboard:
      - Update the card layout and headers to match your new sport/domain.
      - Fuzzy search and filtering logic remain fully modular and will instantly
        work as long as your API endpoint serves matches containing child
        properties.
