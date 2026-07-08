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
// If no data for more than 20 seconds, ESP32 is offline.
const OFFLINE_TIMEOUT_SECONDS = 20;

// =====================================================
// Battery fallback settings
// =====================================================
const V_FULL = 42.0;
const V_EMPTY = 34.0;

const INITIAL_CYCLE_COUNT = 10.0;
const INITIAL_SOH_PERCENT = 98.926;
const FULL_RANGE_KM = 20.0;

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
// Helpers
// =====================================================
function toFiniteNumber(value, fallback = null) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }

  const numberValue = Number(value);

  return Number.isFinite(numberValue)
    ? numberValue
    : fallback;
}

function calculateSOC(voltage) {
  let soc = ((voltage - V_EMPTY) / (V_FULL - V_EMPTY)) * 100;

  if (soc > 100) soc = 100;
  if (soc < 0) soc = 0;

  return Number(soc.toFixed(2));
}

function calculateRange(soc, soh) {
  const safeSoc = Math.max(0, Math.min(100, Number(soc)));
  const safeSoh = Math.max(0, Number(soh));

  const range =
    FULL_RANGE_KM *
    (safeSoc / 100.0) *
    (safeSoh / INITIAL_SOH_PERCENT);

  return Number(Math.max(0, range).toFixed(2));
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
// Existing values:
// voltage
// current
// temperature
// soc
// used_Ah
// used_Wh
// internal_resistance
// gsm_signal
//
// New values:
// cycle_count
// soh
// estimated_range_km
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
      cycle_count,
      soh,
      estimated_range_km,
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

    const voltageValue = toFiniteNumber(voltage);
    const currentValue = toFiniteNumber(current);
    const temperatureValue = toFiniteNumber(temperature);

    if (
      voltageValue === null ||
      currentValue === null ||
      temperatureValue === null
    ) {
      return res.status(400).json({
        ok: false,
        error: "voltage, current and temperature must be valid numbers"
      });
    }

    // Use ESP32 SOC first. Voltage SOC is fallback only.
    const socValue = toFiniteNumber(
      soc,
      calculateSOC(voltageValue)
    );

    const usedAhValue = toFiniteNumber(used_Ah, null);
    const usedWhValue = toFiniteNumber(used_Wh, null);

    const internalResistanceValue = toFiniteNumber(
      internal_resistance,
      null
    );

    const cycleCountValue = toFiniteNumber(
      cycle_count,
      INITIAL_CYCLE_COUNT
    );

    const sohValue = toFiniteNumber(
      soh,
      INITIAL_SOH_PERCENT
    );

    const estimatedRangeValue = toFiniteNumber(
      estimated_range_km,
      calculateRange(socValue, sohValue)
    );

    const gsmSignalValue = toFiniteNumber(
      gsm_signal,
      null
    );

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
        cycle_count,
        soh,
        estimated_range_km,
        gsm_signal,
        created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP())
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
      cycleCountValue,
      sohValue,
      estimatedRangeValue,
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
        cycle_count: cycleCountValue,
        soh: sohValue,
        estimated_range_km: estimatedRangeValue,
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
        cycle_count,
        soh,
        estimated_range_km,
        gsm_signal,
        created_at,
        TIMESTAMPDIFF(
          SECOND,
          created_at,
          UTC_TIMESTAMP()
        ) AS age_seconds
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
        cycle_count: INITIAL_CYCLE_COUNT,
        soh: INITIAL_SOH_PERCENT,
        estimated_range_km: 0,
        gsm_signal: 0,
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
        cycle_count: toFiniteNumber(
          data.cycle_count,
          INITIAL_CYCLE_COUNT
        ),
        soh: toFiniteNumber(
          data.soh,
          INITIAL_SOH_PERCENT
        ),
        estimated_range_km: 0,
        gsm_signal: 0,
        age_seconds: ageSeconds,
        created_at: data.created_at
      });
    }

    // ESP32 online condition
    const voltageValue = toFiniteNumber(data.voltage, 0);
    const currentValue = toFiniteNumber(data.current, 0);
    const temperatureValue = toFiniteNumber(data.temperature, 0);

    const socValue = toFiniteNumber(
      data.soc,
      calculateSOC(voltageValue)
    );

    const usedAhValue = toFiniteNumber(data.used_Ah, 0);
    const usedWhValue = toFiniteNumber(data.used_Wh, 0);

    const internalResistanceValue = toFiniteNumber(
      data.internal_resistance,
      0
    );

    const cycleCountValue = toFiniteNumber(
      data.cycle_count,
      INITIAL_CYCLE_COUNT
    );

    const sohValue = toFiniteNumber(
      data.soh,
      INITIAL_SOH_PERCENT
    );

    const estimatedRangeValue = toFiniteNumber(
      data.estimated_range_km,
      calculateRange(socValue, sohValue)
    );

    const gsmSignalValue = toFiniteNumber(
      data.gsm_signal,
      0
    );

    res.json({
      ok: true,
      online: true,
      status: "ONLINE",
      device_id: data.device_id,
      voltage: voltageValue,
      current: currentValue,
      temperature: temperatureValue,
      soc: socValue,
      used_Ah: usedAhValue,
      used_Wh: usedWhValue,
      internal_resistance: internalResistanceValue,
      cycle_count: cycleCountValue,
      soh: sohValue,
      estimated_range_km: estimatedRangeValue,
      gsm_signal: gsmSignalValue,
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
// =====================================================
app.get("/api/history", async (req, res) => {
  try {
    const [latestRows] = await pool.query(
      `
      SELECT
        created_at,
        TIMESTAMPDIFF(
          SECOND,
          created_at,
          UTC_TIMESTAMP()
        ) AS age_seconds
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
        cycle_count,
        soh,
        estimated_range_km,
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
      online,
      status,
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
