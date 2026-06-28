/**
 * File 4: api/data.js
 * 
 * Vercel Serverless Function Proxy.
 * This script runs securely on Vercel's backend servers. It fetches data
 * from Supabase using hidden environment variables and returns it to your frontend,
 * ensuring no API keys are exposed to the public browser.
 */

const { createClient } = require('@supabase/supabase-js');

module.exports = async (req, res) => {
  // Set headers to allow safe cross-origin resource sharing (CORS)
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version');

  // Handle standard browser preflight options request
  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  // Load backend variables securely from Vercel's configuration panel
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;

  if (!supabaseUrl || !supabaseAnonKey) {
    console.error("Missing credentials in Vercel environment variables.");
    return res.status(500).json({ 
      error: "Database configuration is missing. Verify your Vercel Environment Variables." 
    });
  }

  try {
    const supabase = createClient(supabaseUrl, supabaseAnonKey);

    // Query matches table and pull matching predictions and results automatically
    const { data, error } = await supabase
      .from('matches')
      .select('*, predictions(*), results(*)')
      .order('kickoff_time', { ascending: true });

    if (error) {
      throw error;
    }

    // Return the combined payload securely to the browser
    return res.status(200).json(data);

  } catch (error) {
    console.error("API proxy execution error:", error.message);
    return res.status(500).json({ 
      error: "Internal Server Error occurred while fetching data.",
      details: error.message 
    });
  }
};
