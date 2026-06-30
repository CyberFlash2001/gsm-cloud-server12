const express = require("express");
const mysql = require("mysql2/promise");
const path = require("path");

const app = express();

app.use(express.json({ limit: "1mb" }));

// Serve dashboard files from public folder
app.use(express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 8080;

// =====================================================
// Database configuration
// =====================================================
const dbConfig = {
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  port: Number(process.env.DB_PORT || 3306),
  ssl: {
    minVersion: "TLSv1.2",
    rejectUnauthorized: false
  }
};

let pool;

// =====================================================
// Device settings
// =====================================================
const DEVICE_ID = "battery_monitor_01";

// ESP32 sends every 5 seconds.
// If no data for more than 15 seconds, ESP32 is offline.
const OFFLINE_TIMEOUT_SECONDS = 15;

// =====================================================
// Battery SOC settings
// Change these values according to your battery pack.
// Example for 10S Li-ion:
// Full voltage  = 42V
// Empty voltage = 30V
// =====================================================
const V_FULL = 42.0;
const V_EMPTY = 30.0;

// =====================================================
// Initialize MySQL
// =====================================================
async function initDb() {
  pool = mysql.createPool({
    ...dbConfig,
    waitForConnections: true,
    connectionLimit: 5,
    queueLimit: 0
  });

  const conn = await pool.getConnection();
  await conn.ping();
  conn.release();

  console.log("MySQL connected");
}

// =====================================================
// Helper: calculate SOC
// =====================================================
function calculateSOC(voltage) {
  let soc = ((voltage - V_EMPTY) / (V_FULL - V_EMPTY)) * 100;

  if (soc > 100) soc = 100;
  if (soc < 0) soc = 0;

  return Number(soc.toFixed(1));
}

// =====================================================
// Root route
// =====================================================
app.get("/", (req, res) => {
  res.send("API running. Open /dashboard.html for dashboard.");
});

// =====================================================
// Health check route
// =====================================================
app.get("/health", async (req, res) => {
  try {
    const [rows] = await pool.query("SELECT 1 AS ok");

    res.json({
      ok: true,
      db: rows[0].ok === 1
    });

  } catch (err) {
    console.error("Health check error:", err);

    res.status(500).json({
      ok: false,
      error: err.message
    });
  }
});

// =====================================================
// ESP32 telemetry POST route
// ESP32 sends voltage, current, temperature, gsm_signal
// =====================================================
app.post("/api/telemetry", async (req, res) => {
  try {
    const {
      device_id,
      voltage,
      current,
      temperature,
      gsm_signal
    } = req.body;

    if (
      device_id === undefined ||
      voltage === undefined ||
      current === undefined ||
      temperature === undefined
    ) {
      return res.status(400).json({
        ok: false,
        error: "Missing required fields"
      });
    }

    const sql = `
      INSERT INTO telemetry
      (device_id, voltage, current, temperature, gsm_signal, created_at)
      VALUES (?, ?, ?, ?, ?, UTC_TIMESTAMP())
    `;

    await pool.execute(sql, [
      device_id,
      voltage,
      current,
      temperature,
      gsm_signal ?? null
    ]);

    res.status(200).json({
      ok: true,
      message: "Data stored"
    });

  } catch (err) {
    console.error("Insert error:", err);

    res.status(500).json({
      ok: false,
      error: err.message
    });
  }
});

// =====================================================
// Latest data API for dashboard cards
// If ESP32 is OFF, dashboard cards show zero values.
// Graph does NOT become zero. Graph uses /api/history.
// =====================================================
app.get("/api/latest", async (req, res) => {
  try {
    const [rows] = await pool.query(
      `
      SELECT 
        device_id, 
        voltage, 
        current, 
        temperature, 
        gsm_signal, 
        created_at,
        TIMESTAMPDIFF(SECOND, created_at, UTC_TIMESTAMP()) AS age_seconds
      FROM telemetry
      WHERE device_id = ?
      ORDER BY created_at DESC
      LIMIT 1
      `,
      [DEVICE_ID]
    );

    // No data yet
    if (rows.length === 0) {
      return res.json({
        ok: true,
        online: false,
        status: "OFFLINE",
        device_id: DEVICE_ID,
        voltage: 0,
        current: 0,
        temperature: 0,
        gsm_signal: 0,
        soc: 0,
        soh: 0,
        age_seconds: null,
        created_at: null
      });
    }

    const data = rows[0];
    const ageSeconds = Number(data.age_seconds);

    // ESP32 offline condition
    if (ageSeconds > OFFLINE_TIMEOUT_SECONDS) {
      return res.json({
        ok: true,
        online: false,
        status: "OFFLINE",
        device_id: data.device_id,
        voltage: 0,
        current: 0,
        temperature: 0,
        gsm_signal: 0,
        soc: 0,
        soh: 0,
        age_seconds: ageSeconds,
        created_at: data.created_at
      });
    }

    // ESP32 online condition
    const voltage = Number(data.voltage);
    const current = Number(data.current);
    const temperature = Number(data.temperature);
    const gsmSignal = Number(data.gsm_signal);

    const soc = calculateSOC(voltage);

    // Simple demo SOH value
    // Later, calculate this using battery capacity fade/internal resistance.
    const soh = 100;

    res.json({
      ok: true,
      online: true,
      status: "ONLINE",
      device_id: data.device_id,
      voltage: voltage,
      current: current,
      temperature: temperature,
      gsm_signal: gsmSignal,
      soc: soc,
      soh: soh,
      age_seconds: ageSeconds,
      created_at: data.created_at
    });

  } catch (err) {
    console.error("Latest API error:", err);

    res.status(500).json({
      ok: false,
      error: err.message
    });
  }
});

// =====================================================
// History API for dashboard graphs
// Graph only shows real saved database readings.
// If ESP32 is OFF, graph stops at last real value.
// When ESP32 comes ONLINE again, graph continues.
// =====================================================
app.get("/api/history", async (req, res) => {
  try {
    // Check latest data age for status only
    const [latestRows] = await pool.query(
      `
      SELECT 
        created_at,
        TIMESTAMPDIFF(SECOND, created_at, UTC_TIMESTAMP()) AS age_seconds
      FROM telemetry
      WHERE device_id = ?
      ORDER BY created_at DESC
      LIMIT 1
      `,
      [DEVICE_ID]
    );

    let online = false;
    let status = "OFFLINE";

    if (latestRows.length > 0) {
      const ageSeconds = Number(latestRows[0].age_seconds);

      if (ageSeconds <= OFFLINE_TIMEOUT_SECONDS) {
        online = true;
        status = "ONLINE";
      }
    }

    // Get only real stored readings from MySQL
    const [rows] = await pool.query(
      `
      SELECT voltage, current, temperature, created_at
      FROM telemetry
      WHERE device_id = ?
      ORDER BY created_at DESC
      LIMIT 50
      `,
      [DEVICE_ID]
    );

    res.json({
      ok: true,
      online: online,
      status: status,
      data: rows.reverse()
    });

  } catch (err) {
    console.error("History API error:", err);

    res.status(500).json({
      ok: false,
      error: err.message
    });
  }
});

// =====================================================
// Start server
// =====================================================
initDb()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Server running on port ${PORT}`);
    });
  })
  .catch((err) => {
    console.error("DB init failed:", err);
    process.exit(1);
  });
