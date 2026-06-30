const express = require("express");
const mysql = require("mysql2/promise");
const path = require("path");

const app = express();

app.use(express.json({ limit: "1mb" }));

// Serve dashboard files from public folder
app.use(express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 8080;

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

// Root API test
app.get("/", (req, res) => {
  res.send("API running. Open /dashboard.html for dashboard.");
});

// Health check
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

// ESP32 sends data to this route
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

// Dashboard latest data API
app.get("/api/latest", async (req, res) => {
  try {
    const deviceId = "battery_monitor_01";

    const [rows] = await pool.query(
      `
      SELECT device_id, voltage, current, temperature, gsm_signal, created_at
      FROM telemetry
      WHERE device_id = ?
      ORDER BY created_at DESC
      LIMIT 1
      `,
      [deviceId]
    );

    if (rows.length === 0) {
      return res.status(404).json({
        ok: false,
        error: "No telemetry data found"
      });
    }

    const data = rows[0];

    const voltage = Number(data.voltage);
    const current = Number(data.current);
    const temperature = Number(data.temperature);
    const gsmSignal = Number(data.gsm_signal);

    // Change these two values according to your battery pack.
    // For 10S lithium-ion battery: full = 42V, empty = 30V.
    const V_FULL = 42.0;
    const V_EMPTY = 30.0;

    let soc = ((voltage - V_EMPTY) / (V_FULL - V_EMPTY)) * 100;

    if (soc > 100) soc = 100;
    if (soc < 0) soc = 0;

    // Simple demo SOH value.
    // Later, calculate SOH using battery capacity fade.
    const soh = 100;

    res.json({
      ok: true,
      device_id: data.device_id,
      voltage: voltage,
      current: current,
      temperature: temperature,
      gsm_signal: gsmSignal,
      soc: Number(soc.toFixed(1)),
      soh: soh,
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

// Dashboard history data API
app.get("/api/history", async (req, res) => {
  try {
    const deviceId = "battery_monitor_01";

    const [rows] = await pool.query(
      `
      SELECT voltage, current, temperature, created_at
      FROM telemetry
      WHERE device_id = ?
      ORDER BY created_at DESC
      LIMIT 50
      `,
      [deviceId]
    );

    res.json({
      ok: true,
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
