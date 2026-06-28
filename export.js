/**
 * File 6: export.js
 * 
 * This script runs after the prediction phase on GitHub Actions.
 * It extracts all matches, predictions, and results from Supabase, formats
 * them into a clean research-grade CSV sheet with citations, and writes it to disk.
 */

const fs = require('fs');
const { createClient } = require('@supabase/supabase-js');

// Initialize Supabase Connection
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseServiceRoleKey) {
  console.error("❌ ERROR: Missing Supabase environment keys for CSV export.");
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseServiceRoleKey);

async function exportDatabaseToCSV() {
  console.log("📊 Compiling database tables into CSV research archive...");

  try {
    // 1. Fetch matches along with linked predictions and results
    const { data: matches, error } = await supabase
      .from('matches')
      .select('*, predictions(*), results(*)')
      .order('id', { ascending: true });

    if (error) {
      throw error;
    }

    if (!matches || matches.length === 0) {
      console.log("ℹ️ No matches found in database. Skipping CSV export.");
      return;
    }

    // 2. Define CSV Header Row
    const headers = [
      "Match ID",
      "Home Team",
      "Away Team",
      "Kickoff Time (UTC)",
      "Status",
      "AI Predicted Winner",
      "AI Predicted Score",
      "AI Goalscorers",
      "AI Assists",
      "AI Bookings",
      "AI Injury Predictions",
      "AI Fantasy Tips Summary",
      "Actual Winner",
      "Actual Score",
      "Real Goalscorers",
      "Real Bookings",
      "Real Injuries",
      "AI Prediction Accuracy Status",
      "Google Search Citation URLs (Research Sources)"
    ];

    // Begin building CSV string
    let csvContent = headers.map(h => escapeCSV(h)).join(",") + "\n";

    // 3. Populate rows
    for (const match of matches) {
      const pred = match.predictions && match.predictions.length > 0 ? match.predictions[0] : null;
      const real = match.results && match.results.length > 0 ? match.results[0] : null;

      // Calculate accuracy badge for spreadsheet audit
      let accuracyStatus = "N/A - Match in Progress";
      if (pred && real) {
        const isCorrect = pred.predicted_winner.toLowerCase().trim() === real.actual_winner.toLowerCase().trim();
        accuracyStatus = isCorrect ? "Correct Winner Predicted" : "Incorrect Winner Predicted";
      } else if (!pred && !real) {
        accuracyStatus = "Pending Prediction";
      }

      // Compile data fields
      const row = [
        match.id,
        match.home_team,
        match.away_team,
        match.kickoff_time,
        match.status,
        pred ? pred.predicted_winner : "",
        pred ? pred.predicted_score : "",
        pred ? formatEventsArray(pred.goalscorers) : "",
        pred ? formatEventsArray(pred.assists) : "",
        pred ? formatEventsArray(pred.bookings) : "",
        pred ? formatEventsArray(pred.injuries) : "",
        pred ? pred.fantasy_tips : "",
        real ? real.actual_winner : "",
        real ? real.actual_score : "",
        real ? formatEventsArray(real.goalscorers) : "",
        real ? formatEventsArray(real.bookings) : "",
        real ? formatEventsArray(real.injuries) : "",
        accuracyStatus,
        pred ? extractGroundingSources(pred.grounding_sources) : ""
      ];

      csvContent += row.map(cell => escapeCSV(cell)).join(",") + "\n";
    }

    // 4. Save file to disk
    fs.writeFileSync('wc_predictions_archive.csv', csvContent, 'utf8');
    console.log("✅ Research CSV database successfully saved to 'wc_predictions_archive.csv'!");

  } catch (err) {
    console.error("❌ Failed to generate CSV archive:", err.message);
    process.exit(1);
  }
}

/**
 * Clean cell helper to escape quotes and commas for CSV standard compliance
 */
function escapeCSV(val) {
  if (val === null || val === undefined) return '""';
  let str = typeof val === 'object' ? JSON.stringify(val) : String(val);
  str = str.replace(/"/g, '""'); // Escape double quotes inside the string
  return `"${str}"`;
}

/**
 * Formats JSON database arrays into clean, spreadsheet-friendly text
 * converts [{"player": "L. Messi", "minute": "45"}] to "L. Messi (45')"
 */
function formatEventsArray(arr) {
  if (!arr || !Array.isArray(arr) || arr.length === 0) return "";
  return arr.map(item => {
    let text = item.player || "N/A";
    if (item.minute) text += ` (${item.minute}')`;
    if (item.type) text += ` [${item.type}]`;
    return text;
  }).join('; ');
}

/**
 * Safely extracts raw search citation URLs returned from Gemini GroundingMetadata
 */
function extractGroundingSources(sources) {
  if (!sources || !sources.groundingChunks || !Array.isArray(sources.groundingChunks)) {
    return "";
  }
  return sources.groundingChunks
    .map(chunk => chunk.web && chunk.web.uri ? chunk.web.uri : null)
    .filter(Boolean)
    .join('; ');
}

// Execute Export Pipeline
exportDatabaseToCSV();
