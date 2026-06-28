/**
 * File 1: predict.js
 * 
 * This is the core Node.js script. It communicates with your Supabase database,
 * retrieves pending matches starting in ~2 hours, triggers the Gemini API with
 * live Google Search grounding enabled, parses the predictions, and updates your tables.
 */

const { createClient } = require('@supabase/supabase-js');

// 1. Initialize Supabase Connection using securely loaded environment keys
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const geminiApiKey = process.env.GEMINI_API_KEY;

if (!supabaseUrl || !supabaseServiceRoleKey || !geminiApiKey) {
  console.error("❌ ERROR: Missing required environment keys in GitHub Secrets.");
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseServiceRoleKey);

// Define default model - gemini-2.5-flash is stable, fast, and supports Google Search tools
const MODEL_NAME = "gemini-2.5-flash"; 

async function startPredictionWorkflow() {
  console.log("🚀 Starting Prediction Engine...");
  
  try {
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
      
      // Calculate how many hours until the match starts
      const diffMs = kickoffTime.getTime() - currentTime.getTime();
      const diffHours = diffMs / (1000 * 60 * 60);

      console.log(`🔍 Checking Match ID ${match.id}: ${match.home_team} vs ${match.away_team}`);
      console.log(`   Kickoff Time: ${kickoffTime.toISOString()} (In ${diffHours.toFixed(2)} hours)`);

      // Target matches starting in 2 hours. We add a small buffer (up to 2.5 hours) 
      // to ensure the script doesn't miss a match if it runs a few minutes late.
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

async function runPredictionForMatch(match) {
  // Update status to 'Processing' immediately in Supabase to avoid double-runs
  await supabase
    .from('matches')
    .update({ status: 'Processing' })
    .eq('id', match.id);

  try {
    // 3. Prepare strict formatting prompt for the model
    const targetPrompt = `
      You are an expert World Cup and FIFA Fantasy sports analyst. 
      Analyze the upcoming match between: ${match.home_team} (Home) vs ${match.away_team} (Away).

      IMPORTANT: Since this is exactly 2 hours before the match, official team lineups, late-stage fitness tests, and final tactical updates have been released. Use the Google Search tool to search for real-time lineup announcements, player injuries, tactical previews, and high-quality social trends (like Twitter/X sentiments) for both teams.

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

      Do not output any introductory or conversational text, and do not wrap your JSON in backticks (e.g. \`\`\`json). Return the raw JSON block directly.
    `;

    console.log(`📡 Querying Gemini API (${MODEL_NAME}) with Search Grounding...`);
    
    // 4. Invoke Gemini API directly with live Google Search retrieval enabled
    const apiResponse = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL_NAME}:generateContent?key=${geminiApiKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: targetPrompt }] }],
        tools: [{ google_search_retrieval: {} }], // Triggers Gemini's native live Google Search crawler
        generationConfig: { temperature: 0.15 }  // Lower temperature to force logical/less random outputs
      })
    });

    const responseCode = apiResponse.status;
    const rawText = await apiResponse.text();

    if (responseCode !== 200) {
      throw new Error(`Gemini API Error (HTTP ${responseCode}): ${rawText}`);
    }

    const jsonResponse = JSON.parse(rawText);
    if (!jsonResponse.candidates || jsonResponse.candidates.length === 0) {
      throw new Error("No prediction candidate returned by Gemini API.");
    }

    const generatedText = jsonResponse.candidates[0].content.parts[0].text;
    console.log("⚡ Prediction received. Cleaning response contents...");

    // 5. Clean up any accidental markdown syntax and parse into structured format
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
      console.warn("⚠️ JSON format parsing failed. Storing raw output in database fallback instead.", parseError);
      parsed = {
        winner: "Failed to auto-parse",
        score: "?-?",
        goalscorers: [],
        assists: [],
        bookings: [],
        injuries: [],
        clean_sheets: { home: false, away: false },
        fantasy_tips: "Could not auto-generate fantasy recommendations due to string formatting constraints.",
        analysis: "RAW UNPARSED AI OUTPUT:\n\n" + generatedText
      };
    }

    // 6. Push the predictions to the Supabase predictions table
    console.log(`💾 Storing structured predictions to database table...`);
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

    // 7. Mark match status as 'Completed'
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
    
    // Log the error back inside your Supabase matches table so you can inspect failures
    await supabase
      .from('matches')
      .update({ status: `Error: ${error.message.substring(0, 100)}` })
      .eq('id', match.id);
  }
}

// Start processing matches
startPredictionWorkflow();
