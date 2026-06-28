/**
 * File 1: predict.js (Grounded Tactical Analysis Version)
 * 
 * This version updates the AI engine prompt to generate a deep, structured,
 * multi-paragraph tactical match briefing detailing teams playstyles,
 * key player movements, and chronological narrative for your research.
 */

const { createClient } = require('@supabase/supabase-js');

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
    // 1. Sync upcoming matches (automatic schedule additions)
    await syncUpcomingFixtures();

    // 2. Sync results of completed matches (automatic outcome gathering)
    await syncCompletedResults();

    // 3. Fetch matches with 'Pending' status to evaluate predictions
    const { data: matches, error: fetchError } = await supabase
      .from('matches')
      .select('*')
      .eq('status', 'Pending');

    if (fetchError) {
      throw new Error(`Failed to fetch matches: ${fetchError.message}`);
    }

    if (!matches || matches.length === 0) {
      console.log("ℹ️ No 'Pending' matches found in database. Exiting prediction phase.");
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

      // Window check: Starts predictions strictly between T-2.5 hours and kickoff
      if (diffHours > 0 && diffHours <= 2.5) {
        console.log(`🎯 Match falls in active window! Running prediction pipeline...`);
        await runPredictionForMatch(match);
      } else {
        console.log("⏭️ Match skipped (not inside the 0 to 2.5 hours window).");
      }
    }

  } catch (globalError) {
    console.error("❌ CRITICAL SCRIPT FAILURE:", globalError);
    process.exit(1);
  }
}

/**
 * FEATURE 1: Autonomous Match Syncer
 */
async function syncUpcomingFixtures() {
  console.log("🔍 Checking if database schedule requires autonomous syncing...");

  try {
    const { data: existingMatches, error: matchFetchError } = await supabase
      .from('matches')
      .select('home_team, away_team, kickoff_time');

    if (matchFetchError) throw matchFetchError;

    const { data: pendingMatches, error: pendingFetchError } = await supabase
      .from('matches')
      .select('*')
      .eq('status', 'Pending');

    if (pendingFetchError) throw pendingFetchError;

    if (pendingMatches && pendingMatches.length >= 3) {
      console.log(`ℹ️ Database has ${pendingMatches.length} pending fixtures scheduled. No syncing required.`);
      return;
    }

    console.log("⚠️ Low pending fixtures detected. Syncing future rounds...");

    const existingList = existingMatches.map(m => `${m.home_team} vs ${m.away_team} (${m.kickoff_time})`).join('\n');

    const syncPrompt = `
      You are an automated schedule coordinator for World Cup 2026. 
      Search the web for the official tournament schedule. Identify newly confirmed knockout fixtures (Round of 16, Quarterfinals, Semifinals, and Final) that are officially confirmed but are NOT in this existing schedule list:
      
      ${existingList}

      Return newly identified matches in this raw JSON array format, without markdown backticks:
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
    console.error("⚠️ Autonomous Syncing Warning:", syncError.message);
  }
}

/**
 * FEATURE 2: Autonomous Results Syncer
 */
async function syncCompletedResults() {
  console.log("🔍 Checking for finished matches missing outcome data...");

  try {
    const { data: completedMatches, error: fetchError } = await supabase
      .from('matches')
      .select('*, results(*)');

    if (fetchError) throw fetchError;

    const pendingResults = completedMatches.filter(m => {
      if (m.status !== "Completed") return false;
      const resultsArray = m.results || [];
      return resultsArray.length === 0;
    });

    if (pendingResults.length === 0) {
      console.log("ℹ️ No finished matches missing results data. Skipping outcome sync.");
      return;
    }

    console.log(`📈 Found ${pendingResults.length} matches waiting for actual results...`);

    for (const match of pendingResults) {
      const kickoffTime = new Date(match.kickoff_time);
      const now = new Date();
      const hoursSinceKickoff = (now.getTime() - kickoffTime.getTime()) / (1000 * 60 * 60);

      // Outcome check: Only run if 3.5 hours have passed since kickoff
      if (hoursSinceKickoff > 3.5) {
        console.log(`📡 Fetching official outcomes for: ${match.home_team} vs ${match.away_team}...`);

        const resultPrompt = `
          Search the web for the official final result of the FIFA World Cup 2026 match between: ${match.home_team} vs ${match.away_team}.
          The match kicked off around: ${match.kickoff_time}.

          Your task is to compile the official final statistics of the match in this raw JSON format, without backticks:
          {
            "winner": "Winning team name (or Draw)",
            "score": "Final score line (e.g., 2-1)",
            "goalscorers": [{"player": "Player Name", "minute": "Actual minute"}],
            "assists": [{"player": "Player Name", "minute": "Actual minute"}],
            "bookings": [{"player": "Player Name", "type": "Yellow" or "Red", "minute": "Actual minute"}],
            "injuries": [{"player": "Player Name", "minute": "Actual minute"}],
            "clean_sheets": {"home": true_or_false, "away": true_or_false}
          }
        `;

        const apiResponse = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL_NAME}:generateContent?key=${geminiApiKey}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{ parts: [{ text: resultPrompt }] }],
            tools: [{ google_search_retrieval: {} }],
            generationConfig: { temperature: 0.1 }
          })
        });

        const rawText = await apiResponse.text();
        if (apiResponse.status !== 200) throw new Error(`Results API failed: ${rawText}`);

        const jsonResponse = JSON.parse(rawText);
        let generatedText = jsonResponse.candidates[0].content.parts[0].text.trim();

        if (generatedText.startsWith("```")) {
          const matchRegex = generatedText.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
          if (matchRegex && matchRegex[1]) {
            generatedText = matchRegex[1].trim();
          }
        }

        const parsedResult = JSON.parse(generatedText);

        const { error: insertError } = await supabase
          .from('results')
          .insert({
            match_id: match.id,
            actual_winner: parsedResult.winner,
            actual_score: parsedResult.score,
            goalscorers: parsedResult.goalscorers,
            assists: parsedResult.assists,
            bookings: parsedResult.bookings,
            injuries: parsedResult.injuries,
            clean_sheets: parsedResult.clean_sheets
          });

        if (insertError) {
          console.error(`Failed to save results for Match ID ${match.id}:`, insertError.message);
        } else {
          console.log(`🏆 Successfully compiled results for: ${match.home_team} vs ${match.away_team}`);
        }
      } else {
        console.log(`⏳ Skipping outcome check for ${match.home_team} vs ${match.away_team} (match is currently in progress).`);
      }
    }

  } catch (error) {
    console.error("⚠️ Results Syncer Error:", error.message);
  }
}

/**
 * FEATURE 3: Prediction Compiler with Grounded Tactical Briefing
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
        "analysis": "Provide a comprehensive, multi-paragraph tactical briefing. You must detail: 1) Tactical Playstyles: How both teams will set up (e.g., possession-based structures, defensive lines, or counter-attacking block systems). 2) Player Dynamics: Specific roles on who will do what (e.g., wingers overloading half-spaces or specific structural matchups). 3) Chronological Narrative: How you project the match flow to evolve over 90 minutes (e.g., quiet first halves, late substitution transitions, or physical escalation)."
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
    const groundingMetadata = jsonResponse.candidates[0].groundingMetadata || null;

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
        raw_analysis: parsed.analysis,
        grounding_sources: groundingMetadata
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
