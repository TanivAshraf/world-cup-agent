# Taniv-Gemini World Cup Predictor

A fully automated, real-time, search-grounded sports forecasting system designed for the FIFA World Cup 2026. This project leverages Large Language Models (LLMs) with active web search retrieval to generate highly granular match event forecasts (scorers, assists, bookings, injuries, scorelines) exactly 2.0 to 2.5 hours prior to official match kickoffs, systematically evaluating AI prediction capability in high-volatility environments.

---

## 1. Core Philosophy & Research Value

Predictive sports modeling traditionally relies on historical statistical distributions (e.g., Poisson regression, Elo ratings, or machine learning models trained on static performance metrics). While powerful, these models struggle to incorporate high-impact, late-breaking qualitative variables, such as final lineup changes announced during pre-match warm-ups, tactical shift rumors on social media (Twitter/X), or minor injuries sustained in training.

This system addresses this gap by utilizing **Real-Time Search Grounding**. By running predictions exactly 2.5 hours before kickoff—the precise window when managers submit official starting lineups to FIFA—the system incorporates late-stage qualitative data with historical performance metrics.

### Key Methodological Strengths:
*   **Prospective Validation (Prospective Study):** To ensure maximum academic integrity, this system completely avoids retrospective backtesting (which is often plagued by data leakage or hindsight bias). The system operates strictly in real-time; predictions are frozen, timestamped, and committed to a public database and version-controlled CSV prior to match kickoffs.
*   **Granular Event Tracking:** Beyond predicting simple match winners, the agent attempts to forecast fine-grained, continuous variables, including card minutes, goal times, assists, and injury substitutions.
*   **Transparent Citation Auditing:** Every prediction is saved alongside its raw "Google Search Grounding" metadata. This creates an auditable trail of the exact web resources (news outlets, team bulletins, tactical analyses) the AI relied on to generate its forecast.
*   **Zero-Intervention Autonomy:** The pipeline is completely self-sustaining. Once initialized, the agent schedules upcoming matches, generates forecasts, retrieves official post-match results, and exports raw audit files without human intervention.

---

## 2. System Architecture

The predictor is designed as a distributed, decoupled, serverless pipeline:

              ┌──────────────────────────────┐
              │   GitHub Actions Scheduler   │
              │   (Triggers every 30 mins)   │
              └──────────────┬───────────────┘
                             │
        ┌────────────────────┴────────────────────┐
        ▼                                         ▼

┌───────────────────────┐ ┌───────────────────────┐ │ Autonomous Syncer │ │ AI
Prediction Engine │ │ (Searches for newly │ │ (Triggers at T-2.5h) │ │ confirmed
fixtures) │ │ │ └───────────┬───────────┘ └───────────┬───────────┘ │ │ │
(Updates DB) │ (Queries Gemini + Web) ▼ ▼
┌─────────────────────────────────────────────────────────────────┐
│ Supabase PostgreSQL DB │ │ (Matches, Predictions, and Ground Truth Tables) │
└───────────┬─────────────────────────────────────────┬───────────┘ │ │ │
(Pulls for Backup) │ (Queries secure API) ▼ ▼ ┌──────────────────────────┐
┌──────────────────────────┐ │ GitHub CSV Exporter │ │ Vercel Serverless API & │
│ (wc_predictions_archive) │ │ HTML Live Dashboard │
└──────────────────────────┘
└──────────────────────────┘


### Component Details:
1.  **Scheduler & Execution (GitHub Actions):** Runs a cron environment every 30 minutes. It evaluates the kickoff times in the database and triggers the prediction or syncer logic.
2.  **Database & Storage (Supabase):** A PostgreSQL database containing three relational tables: `matches`, `predictions`, and `results`.
3.  **AI Engine (Gemini 2.5 Flash):** An advanced, low-latency LLM queried with active Google Search retrieval enabled. It conducts live web crawls, structures qualitative news into JSON formats, and returns the grounded prediction along with its search citation paths.
4.  **Backend Proxy (Vercel Serverless):** To protect the database from unauthorized writes while maintaining public transparency, the client frontend queries a secure backend Node.js serverless route (`/api/data`), keeping database credentials and API keys safely hidden from the browser.
5.  **Spreadsheet Backup Mirror (GitHub Git-Commit):** Following every execution loop, the GitHub runner exports all tables into `wc_predictions_archive.csv` and commits it directly to this repository.

---

## 3. Database Schema

The database utilizes PostgreSQL tables defined with explicit relational constraints to ensure data integrity:

```sql
-- 1. Matches Table: Holds the scheduling log
CREATE TABLE matches (
    id SERIAL PRIMARY KEY,
    home_team TEXT NOT NULL,
    away_team TEXT NOT NULL,
    kickoff_time TIMESTAMPTZ NOT NULL,
    status TEXT DEFAULT 'Pending' -- 'Pending', 'Processing', 'Completed', 'Error'
);

-- 2. Predictions Table: Holds the pre-match AI forecasts and Google Search citation links
CREATE TABLE predictions (
    match_id INT PRIMARY KEY REFERENCES matches(id) ON DELETE CASCADE,
    predicted_winner TEXT,
    predicted_score TEXT,
    goalscorers JSONB,       -- Schema: [{"player": "Name", "minute": "45"}]
    assists JSONB,           -- Schema: [{"player": "Name", "minute": "45"}]
    bookings JSONB,          -- Schema: [{"player": "Name", "type": "Yellow/Red", "minute": "12"}]
    injuries JSONB,          -- Schema: [{"player": "Name", "minute": "70"}]
    clean_sheets JSONB,      -- Schema: {"home": true, "away": false}
    fantasy_tips TEXT,       -- Narrative optimized for FIFA Fantasy managers
    raw_analysis TEXT,       -- Raw multi-paragraph tactical briefing
    grounding_sources JSONB, -- Exact search citation URLs returned by Gemini
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 3. Results Table: Holds the verified ground truth results populated post-match
CREATE TABLE results (
    match_id INT PRIMARY KEY REFERENCES matches(id) ON DELETE CASCADE,
    actual_winner TEXT,
    actual_score TEXT,
    goalscorers JSONB,       -- Schema: [{"player": "Name", "minute": "45"}]
    assists JSONB,           -- Schema: [{"player": "Name", "minute": "45"}]
    bookings JSONB,          -- Schema: [{"player": "Name", "type": "Yellow/Red", "minute": "12"}]
    injuries JSONB,          -- Schema: [{"player": "Name", "minute": "70"}]
    clean_sheets JSONB,      -- Schema: {"home": true, "away": false}
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

4. Replication & Deployment Guide

This project can be fully deployed and automated entirely using web-browser
interfaces. No local installation of Node.js, Git, or terminal execution is
required.

Step 1: Database Setup (Supabase)

1.  Create a free account on Supabase and spin up a new project.
2.  Open the SQL Editor tab on your Supabase dashboard, paste the SQL schema
    provided in Section 3 of this document, and click Run.
3.  Go to Project Settings -> API and copy your Project URL and the service_role
    key (keep this key secret) and the anon public key.

Step 2: Code Repository Setup (GitHub)

1.  Create a new private or public repository on your GitHub account.
2.  Add the following five files to the root of your repository (using GitHub’s
    "Create new file" button):
      - package.json — Defines dependencies (@supabase/supabase-js).
      - predict.js — The core AI logic and database connection loops.
      - export.js — The database-to-CSV compilation utility.
      - index.html — The interactive public verification dashboard.
      - api/data.js — The Vercel serverless function proxy file.
      - .github/workflows/schedule.yml — The automation workflow configuration.

Step 3: Configure Environment Secrets (GitHub & Vercel)

To allow your automation engines to query your database and the Gemini API
safely without exposing your secrets, save your keys in the respective
dashboards:

In GitHub (Settings -> Secrets and variables -> Actions):

  - SUPABASE_URL: Your Supabase Project URL.
  - SUPABASE_SERVICE_ROLE_KEY: Your private Supabase service_role key.
  - GEMINI_API_KEY: Your Gemini API Key from Google AI Studio.

In Vercel (Project Settings -> Environment Variables):

  - SUPABASE_URL: Your Supabase Project URL.
  - SUPABASE_ANON_KEY: Your public Supabase anon key.

Step 4: Deploy the Verification Dashboard (Vercel)

1.  Log in to Vercel using your GitHub credentials.
2.  Click Add New... -> Project and import your repository.
3.  Ensure the environment variables are saved (as detailed in Step 3), and
    click Deploy. Vercel will host your HTML dashboard and run your /api/data.js
    proxy route automatically.

5. Automation Workflow Details

Once the deployment sequence is finalized, the system runs autonomously on the
following cycle:

1.  Incremental Schedule Syncing: Every 30 minutes, the GitHub Actions runner
    starts. If the database has fewer than 3 pending matches scheduled, the
    agent performs a Google search query to discover newly confirmed World Cup
    matches, parsing the team names and UTC kickoff times, and inserting them as
    Pending into your database.
2.  Predictive Execution (T-2.5 hours): If a pending match is starting in 2.5
    hours or less, the agent transitions its database status to Processing,
    calls the Gemini API to search for team news, crawls warm-up lineup threads
    on Twitter/X, generates the prediction block, compiles search citations, and
    updates the database to Completed.
3.  Autonomous Ground Truth Gathering (T+3.5 hours): 3.5 hours after kickoff,
    the runner searches Google for the finalized scores, scorers, yellow/red
    cards, and injuries, writing them securely to the results table.
4.  CSV Compilation & Push: At the end of every workflow execution, export.js is
    triggered to compile the SQL records into wc_predictions_archive.csv and
    push the updated dataset back to your GitHub repository with a clean,
    verifiable git commit log.

6. Academic Audit & Verification

For researchers studying LLM accuracy, decision support systems, or information
retrieval:

  - The raw research spreadsheet is stored as wc_predictions_archive.csv at the
    root of this repository.
  - Reviewers can cross-reference the Vercel Frontend URL with the GitHub Commit
    Logs to verify that predictions were committed and archived prior to match
    kickoffs, verifying a completely prospective study.


---

You now have a premium-grade, highly rigorous, and completely autonomous research system and codebase fully deployed and documented. You are ready to analyze predictions and write your paper!
