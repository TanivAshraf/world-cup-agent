/**
 * File 1: predict.js (Updated with Autonomous Bracket Syncer)
 * 
 * This script runs every 30 minutes. It:
 * 1. Checks if the database is running out of scheduled matches.
 *    If yes, it uses Gemini Search Grounding to automatically discover 
 *    and schedule newly confirmed World Cup matches.
 * 2. Processes pending matches that are within their 2.5-hour kickoff window.
 */

const { createClient } = require('@supabase/supabase-js');

// Initialize Supabase Connection
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const geminiApiKey = process.env.GEMINI_API_KEY;

if (!supabaseUrl || !supabaseServiceRoleKey || !geminiApiKey) {
  console.error("❌ ERROR: Missing required environment keys in GitHub Secrets.");
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseServiceRoleKey);
const MODEL_NAME = "gemini-2.5-flash"; 

async function startPredictionWorkflow() {
  console.log("🚀 Starting Prediction Engine...");
  
  try {
    // 1. Run the Autonomous Bracket Syncer to find new matches
    await syncUpcomingFixtures();

    // 2. Fetch matches from your database where Status is 'Pending'
    const { data: matches, error: fetchError } = await supabase
      .from('matches')
      .select('*')
      .eq('status', 'Pending');

    if (fetchError) {
      throw new Error(`Failed to fetch matches: ${fetchError.message}`);
    }

    if (!matches || matches.length === 0) {
      console.log("ℹ️ No 'Pending' matches found in database. Exiting workflow.");
      return;
    }

    const currentTime = new Date();
    console.log(`📊 Processing ${matches.length} pending matches. Current UTC: ${currentTime.toISOString()}`);

    for (const match of matches) {
      const kickoffTime = new Date(match.kickoff_time);
      const diffMs = kickoffTime.getTime() - currentTime.getTime();
      const diffHours = diffMs / (1000 * 60 * 60);

      console.log(`🔍 Checking Match ID ${match.id}: ${match.home_team} vs ${match.away_team}`);
      console.log(`   Kickoff Time: ${kickoffTime.toISOString()} (In ${diffHours.toFixed(2)} hours)`);

      // Trigger if match starts in 2.5 hours or less
      if (diffHours > 0 && diffHours <= 2.5) {
        console.log(`🎯 Match falls in 2-hour window! Initiating AI prediction pipeline...`);
        await runPredictionForMatch(match);
      } else {
        console.log(`⏭️ Match skipped (not inside the 0 to 2.5 hours window).`);
      }
    }

  } catch (globalError) {
    console.error("❌ CRITICAL SCRIPT FAILURE:", globalError);
    process.exit(1);
  }
}

/**
 * Autonomous Bracket Syncer
 * Uses Gemini Search Grounding to discover newly confirmed fixtures
 * and inserts them into the database without manual human intervention.
 */
async function syncUpcomingFixtures() {
  console.log("🔍 Checking if database schedule requires autonomous syncing...");

  try {
    // Fetch all existing matches currently in the database to prevent duplicates
    const { data: existingMatches, error: matchFetchError } = await supabase
      .from('matches')
      .select('home_team, away_team, kickoff_time');

    if (matchFetchError) throw matchFetchError;

    // Filter to find upcoming pending matches
    const { data: pendingMatches, error: pendingFetchError } = await supabase
      .from('matches')
      .select('*')
      .eq('status', 'Pending');

    if (pendingFetchError) throw pendingFetchError;

    // If we have 3 or more pending matches scheduled, we don't need to query the API (saves tokens)
    if (pendingMatches && pendingMatches.length >= 3) {
      console.log(`ℹ️ Database has ${pendingMatches.length} pending fixtures scheduled. No syncing required.`);
      return;
    }

    console.log("⚠️ Low pending fixtures detected. Triggering Gemini to discover next round matches...");

    // Format list of existing matches so Gemini knows what is already scheduled
    const existingList = existingMatches.map(m => `${m.home_team} vs ${m.away_team} (${m.kickoff_time})`).join('\n');

    const syncPrompt = `
      You are an automated schedule coordinator for World Cup 2026. 
      Search the web for the official tournament schedule. Identify newly confirmed knockout fixtures (Round of 16, Quarterfinals, Semifinals, and Final) that are officially confirmed but are NOT in this existing schedule list:
      
      ${existingList}

      Your task is to identify confirmed upcoming matches and return them in this raw JSON array format, without markdown backticks:
      [
        {"home_team": "Team A", "away_team": "Team B", "kickoff_time": "YYYY-MM-DD HH:MM:SS+00"}
      ]

      Ensure kickoff times are strictly returned in UTC/GMT time format (ending with +00).
      If no new matches are officially scheduled or confirmed yet, return an empty array: []
    `;

    const apiResponse = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL_NAME}:generateContent?key=${geminiApiKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: syncPrompt }] }],
        tools: [{ google_search_retrieval: {} }],
        generationConfig: { temperature: 0.1 }
      })
    });

    const responseCode = apiResponse.status;
    const rawText = await apiResponse.text();

    if (responseCode !== 200) {
      throw new Error(`Gemini Sync API Error (HTTP ${responseCode}): ${rawText}`);
    }

    const jsonResponse = JSON.parse(rawText);
    let generatedText = jsonResponse.candidates[0].content.parts[0].text.trim();

    // Clean JSON formatting
    if (generatedText.startsWith("```")) {
      const matchRegex = generatedText.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
      if (matchRegex && matchRegex[1]) {
        generatedText = matchRegex[1].trim();
      }
    }

    const newMatches = JSON.parse(generatedText);

    if (newMatches && Array.isArray(newMatches) && newMatches.length > 0) {
      console.log(`✨ Found ${newMatches.length} new confirmed matches. Saving to database...`);
      
      for (const newMatch of newMatches) {
        // Prevent duplicate insertions
        const isDuplicate = existingMatches.some(em => 
          em.home_team.toLowerCase() === newMatch.home_team.toLowerCase() && 
          em.away_team.toLowerCase() === newMatch.away_team.toLowerCase()
        );

        if (!isDuplicate) {
          const { error: insertError } = await supabase
            .from('matches')
            .insert({
              home_team: newMatch.home_team,
              away_team: newMatch.away_team,
              kickoff_time: newMatch.kickoff_time,
              status: 'Pending'
            });

          if (insertError) {
            console.error(`Failed to insert match: ${newMatch.home_team} vs ${newMatch.away_team}`, insertError.message);
          } else {
            console.log(`✅ Successfully scheduled new match: ${newMatch.home_team} vs ${newMatch.away_team}`);
          }
        }
      }
    } else {
      console.log("ℹ️ No newly confirmed upcoming matches found online yet.");
    }

  } catch (syncError) {
    console.error("⚠️ Autonomous Syncing Warning (Script will still attempt to predict existing matches):", syncError.message);
  }
}

/**
 * Handles the prediction pipeline for a single row index.
 */
async function runPredictionForMatch(match) {
  await supabase
    .from('matches')
    .update({ status: 'Processing' })
    .eq('id', match.id);

  try {
    const targetPrompt = `
      You are an expert World Cup and FIFA Fantasy sports analyst. 
      Analyze the upcoming match between: ${match.home_team} (Home) vs ${match.away_team} (Away).

      IMPORTANT: Use the Google Search tool to search for real-time lineup announcements, player injuries, tactical previews, and high-quality social trends (like Twitter/X sentiments) for both teams.

      You must structure your entire response in the following strict JSON format:
      {
        "winner": "Predicted winning team name (or Draw)",
        "score": "Predicted fulltime score (e.g., 2-1)",
        "goalscorers": [{"player": "Player Name", "minute": "Estimated minute"}],
        "assists": [{"player": "Player Name", "minute": "Estimated minute"}],
        "bookings": [{"player": "Player Name", "type": "Yellow" or "Red", "minute": "Estimated minute"}],
        "injuries": [{"player": "Player Name", "minute": "Estimated minute"}],
        "clean_sheets": {"home": true_or_false, "away": true_or_false},
        "fantasy_tips": "A couple of sentences outlining the best players to captain, safe picks, and potential differential options for official FIFA Fantasy.",
        "analysis": "A detailed 1-2 paragraph research-grade breakdown of line-up trends, injuries, tactical reasons, or social sentiments that justify these choices."
      }

      Do not output any introductory or conversational text, and do not wrap your JSON in backticks. Return the raw JSON block directly.
    `;

    console.log(`📡 Querying Gemini API (${MODEL_NAME}) with Search Grounding...`);
    
    const apiResponse = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL_NAME}:generateContent?key=${geminiApiKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: targetPrompt }] }],
        tools: [{ google_search_retrieval: {} }],
        generationConfig: { temperature: 0.15 }
      })
    });

    const responseCode = apiResponse.status;
    const rawText = await apiResponse.text();

    if (responseCode !== 200) {
      throw new Error(`Gemini API Error (HTTP ${responseCode}): ${rawText}`);
    }

    const jsonResponse = JSON.parse(rawText);
    const generatedText = jsonResponse.candidates[0].content.parts[0].text;
    console.log("⚡ Prediction received. Cleaning response contents...");

    let cleanText = generatedText.trim();
    if (cleanText.startsWith("```")) {
      const matchRegex = cleanText.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
      if (matchRegex && matchRegex[1]) {
        cleanText = matchRegex[1].trim();
      }
    }

    let parsed;
    try {
      parsed = JSON.parse(cleanText);
    } catch (parseError) {
      console.warn("⚠️ JSON format parsing failed. Storing raw output.", parseError);
      parsed = {
        winner: "Failed to auto-parse",
        score: "?-?",
        goalscorers: [],
        assists: [],
        bookings: [],
        injuries: [],
        clean_sheets: { home: false, away: false },
        fantasy_tips: "Could not auto-generate fantasy recommendations.",
        analysis: generatedText
      };
    }

    console.log(`💾 Storing predictions to database...`);
    const { error: insertError } = await supabase
      .from('predictions')
      .upsert({
        match_id: match.id,
        predicted_winner: parsed.winner,
        predicted_score: parsed.score,
        goalscorers: parsed.goalscorers,
        assists: parsed.assists,
        bookings: parsed.bookings,
        injuries: parsed.injuries,
        clean_sheets: parsed.clean_sheets,
        fantasy_tips: parsed.fantasy_tips,
        raw_analysis: parsed.analysis
      });

    if (insertError) {
      throw new Error(`Failed to save predictions: ${insertError.message}`);
    }

    const { error: updateError } = await supabase
      .from('matches')
      .update({ status: 'Completed' })
      .eq('id', match.id);

    if (updateError) {
      throw new Error(`Failed to update match status: ${updateError.message}`);
    }

    console.log(`✅ Success! Predictions processed for: ${match.home_team} vs ${match.away_team}`);

  } catch (error) {
    console.error(`❌ Error predicting Match ID ${match.id}:`, error);
    await supabase
      .from('matches')
      .update({ status: `Error: ${error.message.substring(0, 100)}` })
      .eq('id', match.id);
  }
}

startPredictionWorkflow();
