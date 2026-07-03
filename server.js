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
const OFFLINE_TIMEOUT_SECONDS = 20;

// =====================================================
// Battery SOC fallback settings
// If ESP32 does not send SOC, server calculates simple voltage SOC.
// But your ESP32 SOC is better, so server will use ESP32 SOC first.
// =====================================================
const V_FULL = 42.0;
const V_EMPTY = 34.0;

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
// Helper: calculate fallback SOC from voltage
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
//
// ESP32 sends:
// voltage,
// current,
// temperature,
// soc,
// used_Ah,
// used_Wh,
// internal_resistance,
// gsm_signal
// =====================================================
app.post("/api/telemetry", async (req, res) => {
  try {
    const {
      device_id,
      voltage,
      current,
      temperature,
      soc,
      used_Ah,
      used_Wh,
      internal_resistance,
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

    const voltageValue = Number(voltage);
    const currentValue = Number(current);
    const temperatureValue = Number(temperature);

    // Use ESP32 SOC if available. Otherwise use simple voltage SOC.
    const socValue =
      soc !== undefined && soc !== null
        ? Number(soc)
        : calculateSOC(voltageValue);

    const usedAhValue =
      used_Ah !== undefined && used_Ah !== null
        ? Number(used_Ah)
        : null;

    const usedWhValue =
      used_Wh !== undefined && used_Wh !== null
        ? Number(used_Wh)
        : null;

    const internalResistanceValue =
      internal_resistance !== undefined && internal_resistance !== null
        ? Number(internal_resistance)
        : null;

    const gsmSignalValue =
      gsm_signal !== undefined && gsm_signal !== null
        ? Number(gsm_signal)
        : null;

    const sql = `
      INSERT INTO telemetry
      (
        device_id,
        voltage,
        \`current\`,
        temperature,
        soc,
        used_Ah,
        used_Wh,
        internal_resistance,
        gsm_signal,
        created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP())
    `;

    await pool.execute(sql, [
      device_id,
      voltageValue,
      currentValue,
      temperatureValue,
      socValue,
      usedAhValue,
      usedWhValue,
      internalResistanceValue,
      gsmSignalValue
    ]);

    res.status(200).json({
      ok: true,
      message: "Data stored",
      received: {
        device_id,
        voltage: voltageValue,
        current: currentValue,
        temperature: temperatureValue,
        soc: socValue,
        used_Ah: usedAhValue,
        used_Wh: usedWhValue,
        internal_resistance: internalResistanceValue,
        gsm_signal: gsmSignalValue
      }
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
// =====================================================
app.get("/api/latest", async (req, res) => {
  try {
    const [rows] = await pool.query(
      `
      SELECT 
        device_id, 
        voltage, 
        \`current\` AS current, 
        temperature,
        soc,
        used_Ah,
        used_Wh,
        internal_resistance,
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
        soc: 0,
        used_Ah: 0,
        used_Wh: 0,
        internal_resistance: 0,
        gsm_signal: 0,
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
        soc: 0,
        used_Ah: 0,
        used_Wh: 0,
        internal_resistance: 0,
        gsm_signal: 0,
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

    const soc =
      data.soc !== null && data.soc !== undefined
        ? Number(data.soc)
        : calculateSOC(voltage);

    const usedAh =
      data.used_Ah !== null && data.used_Ah !== undefined
        ? Number(data.used_Ah)
        : 0;

    const usedWh =
      data.used_Wh !== null && data.used_Wh !== undefined
        ? Number(data.used_Wh)
        : 0;

    const internalResistance =
      data.internal_resistance !== null && data.internal_resistance !== undefined
        ? Number(data.internal_resistance)
        : 0;

    // Simple demo SOH value
    // Later you can calculate SOH using capacity fade and internal resistance increase.
    const soh = 100;

    res.json({
      ok: true,
      online: true,
      status: "ONLINE",
      device_id: data.device_id,
      voltage: voltage,
      current: current,
      temperature: temperature,
      soc: soc,
      used_Ah: usedAh,
      used_Wh: usedWh,
      internal_resistance: internalResistance,
      gsm_signal: gsmSignal,
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

    // Get real stored readings from MySQL
    const [rows] = await pool.query(
      `
      SELECT 
        voltage,
        \`current\` AS current,
        temperature,
        soc,
        used_Ah,
        used_Wh,
        internal_resistance,
        gsm_signal,
        created_at
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
