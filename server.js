const express = require("express");
const mysql = require("mysql2/promise");
const path = require("path");

const {
  predictSOHFromAzureML
} = require("./app_service_ml_helper");

const app = express();

app.use(express.json({ limit: "1mb" }));

// Serve dashboard files from public folder
app.use(express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 8080;


// =====================================================
// DATABASE CONFIGURATION
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
// DEVICE SETTINGS
// =====================================================

const DEVICE_ID = "battery_monitor_01";


// ESP32 sends data every 5 seconds.
//
// If no telemetry is received for more than
// 20 seconds, the device is considered offline.

const OFFLINE_TIMEOUT_SECONDS = 20;


// =====================================================
// BATTERY SOC FALLBACK SETTINGS
// =====================================================

const V_FULL = 42.0;

const V_EMPTY = 34.0;


// =====================================================
// RANGE SETTINGS
// =====================================================

const FULL_BIKE_RANGE_KM = 20.0;


// =====================================================
// INITIALIZE MYSQL
// =====================================================

async function initDb() {

  pool = mysql.createPool({

    ...dbConfig,

    waitForConnections: true,

    connectionLimit: 5,

    queueLimit: 0

  });


  const connection =
    await pool.getConnection();


  try {

    await connection.ping();

  } finally {

    connection.release();

  }


  console.log("MySQL connected");

}


// =====================================================
// CALCULATE FALLBACK SOC
// =====================================================

function calculateSOC(voltage) {

  let soc =

    (
      (voltage - V_EMPTY) /

      (V_FULL - V_EMPTY)

    ) * 100;


  if (soc > 100) {

    soc = 100;

  }


  if (soc < 0) {

    soc = 0;

  }


  return Number(

    soc.toFixed(1)

  );

}


// =====================================================
// CALCULATE ESTIMATED RANGE
//
// 100% SOC = 20 km
// =====================================================

function calculateEstimatedRange(soc) {

  let safeSOC =
    Number(soc);


  if (!Number.isFinite(safeSOC)) {

    safeSOC = 0;

  }


  if (safeSOC > 100) {

    safeSOC = 100;

  }


  if (safeSOC < 0) {

    safeSOC = 0;

  }


  const estimatedRange =

    FULL_BIKE_RANGE_KM *

    (
      safeSOC / 100.0
    );


  return Number(

    estimatedRange.toFixed(2)

  );

}


// =====================================================
// STEP 27
//
// CLAIM ONE BATTERY CYCLE FOR ONE SOH PREDICTION
// =====================================================

async function claimCycleForSOH(

  deviceId,

  cycleCount

) {


  // ---------------------------------------------------
// TRY TO INSERT A NEW CYCLE
// ---------------------------------------------------

  const [insertResult] =

    await pool.query(

      `
      INSERT IGNORE INTO
      battery_soh_cycle_gate
      (
        device_id,
        cycle_count,
        status,
        last_attempt_at
      )

      VALUES
      (
        ?,
        ?,
        'processing',
        UTC_TIMESTAMP()
      )
      `,

      [

        deviceId,

        cycleCount

      ]

    );


  // ---------------------------------------------------
// NEW CYCLE
//
// affectedRows = 1
//
// THIS REQUEST CAN RUN THE ML MODEL
// ---------------------------------------------------

  if (

    insertResult.affectedRows === 1

  ) {

    return true;

  }


  // ---------------------------------------------------
// RETRY FAILED ML INFERENCE AFTER 10 MINUTES
//
// RECOVER STUCK PROCESSING STATUS AFTER 15 MINUTES
// ---------------------------------------------------

  const [retryResult] =

    await pool.query(

      `
      UPDATE battery_soh_cycle_gate

      SET

        status = 'processing',

        last_attempt_at =
          UTC_TIMESTAMP(),

        error_message = NULL

      WHERE

        device_id = ?

        AND cycle_count = ?

        AND
        (

          (
            status = 'failed'

            AND last_attempt_at <=
              DATE_SUB
              (
                UTC_TIMESTAMP(),

                INTERVAL 10 MINUTE
              )
          )

          OR

          (
            status = 'processing'

            AND last_attempt_at <=
              DATE_SUB
              (
                UTC_TIMESTAMP(),

                INTERVAL 15 MINUTE
              )
          )

        )
      `,

      [

        deviceId,

        cycleCount

      ]

    );


  return (

    retryResult.affectedRows === 1

  );

}


// =====================================================
// STEP 28
//
// PROCESS CYCLE-TRIGGERED SOH PREDICTION
//
// AZURE ML RUNS ONCE FOR EACH NEW INTEGER CYCLE
// =====================================================

async function processCycleTriggeredSOH(

  telemetry

) {


  const deviceId =

    telemetry.device_id ||

    DEVICE_ID;


  let cycleCount = null;


  let cycleClaimed = false;


  try {


    // =================================================
// READ CURRENT BATTERY CYCLE COUNT
// =================================================

    const [cycleRows] =

      await pool.query(

        `
        SELECT cycle_count

        FROM battery_cycle_state

        WHERE device_id = ?

        LIMIT 1
        `,

        [

          deviceId

        ]

      );


    if (

      cycleRows.length === 0

    ) {

      throw new Error(

        `No cycle count configured for ${deviceId}`

      );

    }


    cycleCount =

      Number(

        cycleRows[0].cycle_count

      );


    // ML cycle count must be an integer.

    if (

      !Number.isInteger(cycleCount)

    ) {

      throw new Error(

        `Invalid integer cycle count: ${cycleCount}`

      );

    }


    // =================================================
// CHECK WHETHER SOH HAS ALREADY BEEN PREDICTED
// FOR THIS CYCLE
// =================================================

    cycleClaimed =

      await claimCycleForSOH(

        deviceId,

        cycleCount

      );


    if (

      !cycleClaimed

    ) {


      console.log(

        `[SOH] Skip ML | ` +

        `Device=${deviceId} | ` +

        `Cycle=${cycleCount} | ` +

        `Already processed or processing`

      );


      return;

    }


    console.log(

      `[SOH] New cycle detected | ` +

      `Device=${deviceId} | ` +

      `Cycle=${cycleCount}`

    );


    // =================================================
// PREPARE THE EXACT 8 LASSO MODEL FEATURES
// =================================================

    const requiredFeatures = {


      cycle_count:

        cycleCount,


      voltage:

        Number(

          telemetry.voltage

        ),


      current:

        Number(

          telemetry.current

        ),


      temperature:

        Number(

          telemetry.temperature

        ),


      internal_resistance:

        Number(

          telemetry.internal_resistance

        ),


      used_ah:

        Number(

          telemetry.used_ah

        ),


      soc:

        Number(

          telemetry.soc

        ),


      used_wh:

        Number(

          telemetry.used_wh

        )


    };


    // =================================================
// VALIDATE ML FEATURES
// =================================================

    for (

      const [

        featureName,

        featureValue

      ]

      of Object.entries(

        requiredFeatures

      )

    ) {


      if (

        !Number.isFinite(

          featureValue

        )

      ) {


        throw new Error(

          `Invalid ML feature ` +

          `${featureName}: ` +

          `${featureValue}`

        );

      }

    }


    // =================================================
// CALL THE DEPLOYED AZURE ML LASSO MODEL
//
// IMPORTANT:
//
// THIS IS MODEL INFERENCE.
//
// THE MODEL IS NOT REDEPLOYED.
// =================================================

    const prediction =

      await predictSOHFromAzureML(

        requiredFeatures

      );


    const predictedSOH =

      Number(

        prediction.soh

      );


    const solHealthMargin =

      Number(

        prediction.sol_health_margin

      );


    // =================================================
// VALIDATE AZURE ML OUTPUT
// =================================================

    if (

      !Number.isFinite(

        predictedSOH

      )

    ) {


      throw new Error(

        `Invalid SOH returned by ML: ` +

        `${predictedSOH}`

      );

    }


    if (

      !Number.isFinite(

        solHealthMargin

      )

    ) {


      throw new Error(

        `Invalid SOL health margin returned by ML: ` +

        `${solHealthMargin}`

      );

    }


    // =================================================
// GET MYSQL CONNECTION
// =================================================

    const connection =

      await pool.getConnection();


    try {


      // =================================================
  // START MYSQL TRANSACTION
  // =================================================

      await connection.beginTransaction();


      // =================================================
  // SAVE ONE SOH RESULT FOR THIS CYCLE
  // =================================================

      await connection.query(

        `
        INSERT INTO battery_health_history
        (
          device_id,
          cycle_count,
          soh,
          sol_health_margin,
          model_name,
          predicted_at
        )

        VALUES
        (
          ?,
          ?,
          ?,
          ?,
          ?,
          UTC_TIMESTAMP()
        )

        ON DUPLICATE KEY UPDATE

          soh =
            VALUES(soh),

          sol_health_margin =
            VALUES(sol_health_margin),

          model_name =
            VALUES(model_name),

          predicted_at =
            UTC_TIMESTAMP()
        `,

        [

          deviceId,

          cycleCount,

          predictedSOH,

          solHealthMargin,

          prediction.model_name

        ]

      );


      // =================================================
  // UPDATE THE LATEST SOH VALUE
  //
  // DASHBOARD READS THIS TABLE
  // =================================================

      await connection.query(

        `
        INSERT INTO battery_health_latest
        (
          device_id,
          cycle_count,
          soh,
          sol_health_margin,
          model_name
        )

        VALUES
        (
          ?,
          ?,
          ?,
          ?,
          ?
        )

        ON DUPLICATE KEY UPDATE

          cycle_count =
            VALUES(cycle_count),

          soh =
            VALUES(soh),

          sol_health_margin =
            VALUES(sol_health_margin),

          model_name =
            VALUES(model_name),

          updated_at =
            CURRENT_TIMESTAMP
        `,

        [

          deviceId,

          cycleCount,

          predictedSOH,

          solHealthMargin,

          prediction.model_name

        ]

      );


      // =================================================
  // MARK THIS CYCLE AS COMPLETED
  // =================================================

      await connection.query(

        `
        UPDATE battery_soh_cycle_gate

        SET

          status = 'completed',

          completed_at =
            UTC_TIMESTAMP(),

          error_message = NULL

        WHERE

          device_id = ?

          AND cycle_count = ?
        `,

        [

          deviceId,

          cycleCount

        ]

      );


      // =================================================
  // COMMIT DATABASE TRANSACTION
  // =================================================

      await connection.commit();


      console.log(

        `[SOH] Prediction completed | ` +

        `Device=${deviceId} | ` +

        `Cycle=${cycleCount} | ` +

        `SOH=${predictedSOH}% | ` +

        `SOL=${solHealthMargin}%`

      );


    } catch (

      databaseError

    ) {


      await connection.rollback();


      throw databaseError;


    } finally {


      connection.release();


    }


  } catch (

    error

  ) {


    // =================================================
// MARK FAILED SOH PREDICTION
// =================================================

    if (

      cycleClaimed &&

      cycleCount !== null

    ) {


      try {


        await pool.query(

          `
          UPDATE battery_soh_cycle_gate

          SET

            status = 'failed',

            last_attempt_at =
              UTC_TIMESTAMP(),

            error_message = ?

          WHERE

            device_id = ?

            AND cycle_count = ?
          `,

          [

            String(

              error.message

            ).substring(

              0,

              500

            ),

            deviceId,

            cycleCount

          ]

        );


      } catch (

        gateError

      ) {


        console.error(

          "[SOH] Failed to update cycle gate:",

          gateError.message

        );


      }

    }


    throw error;

  }

}


// =====================================================
// ROOT ROUTE
// =====================================================

app.get(

  "/",

  (

    req,

    res

  ) => {


    res.send(

      "API running. Open /dashboard.html for dashboard."

    );

  }

);


// =====================================================
// HEALTH CHECK ROUTE
// =====================================================

app.get(

  "/health",

  async (

    req,

    res

  ) => {


    try {


      const [rows] =

        await pool.query(

          "SELECT 1 AS ok"

        );


      res.json({

        ok: true,


        db:

          rows[0].ok === 1,


        azure_ml_configured:

          Boolean(

            process.env.AZURE_ML_SCORING_URI

          )

          &&

          Boolean(

            process.env.AZURE_ML_API_KEY

          )

      });


    } catch (

      err

    ) {


      console.error(

        "Health check error:",

        err

      );


      res.status(500).json({

        ok: false,

        error: err.message

      });

    }

  }

);


// =====================================================
// ESP32 TELEMETRY POST ROUTE
//
// ESP32 SENDS:
//
// device_id
// voltage
// current
// temperature
// soc
// used_Ah
// used_Wh
// internal_resistance
// gsm_signal
//
// TELEMETRY IS SAVED EVERY REQUEST.
//
// AZURE ML IS TRIGGERED ONCE PER NEW CYCLE.
// =====================================================

app.post(

  "/api/telemetry",

  async (

    req,

    res

  ) => {


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


      // =================================================
  // CHECK REQUIRED TELEMETRY
  // =================================================

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


      // =================================================
  // CONVERT VALUES
  // =================================================

      const deviceIdValue =

        String(

          device_id ||

          DEVICE_ID

        );


      const voltageValue =

        Number(

          voltage

        );


      const currentValue =

        Number(

          current

        );


      const temperatureValue =

        Number(

          temperature

        );


      // =================================================
  // USE ESP32 SOC
  //
  // FALL BACK TO VOLTAGE SOC
  // =================================================

      const socValue =

        soc !== undefined &&

        soc !== null

          ?

          Number(

            soc

          )

          :

          calculateSOC(

            voltageValue

          );


      // =================================================
  // USED AH
  // =================================================

      const usedAhValue =

        used_Ah !== undefined &&

        used_Ah !== null

          ?

          Number(

            used_Ah

          )

          :

          null;


      // =================================================
  // USED WH
  // =================================================

      const usedWhValue =

        used_Wh !== undefined &&

        used_Wh !== null

          ?

          Number(

            used_Wh

          )

          :

          null;


      // =================================================
  // INTERNAL RESISTANCE
  // =================================================

      const internalResistanceValue =

        internal_resistance !== undefined &&

        internal_resistance !== null

          ?

          Number(

            internal_resistance

          )

          :

          null;


      // =================================================
  // GSM SIGNAL
  // =================================================

      const gsmSignalValue =

        gsm_signal !== undefined &&

        gsm_signal !== null

          ?

          Number(

            gsm_signal

          )

          :

          null;


      // =================================================
  // VALIDATE MAIN TELEMETRY VALUES
  // =================================================

      if (

        !Number.isFinite(

          voltageValue

        )

        ||

        !Number.isFinite(

          currentValue

        )

        ||

        !Number.isFinite(

          temperatureValue

        )

        ||

        !Number.isFinite(

          socValue

        )

      ) {


        return res.status(400).json({

          ok: false,

          error:

            "Invalid numeric telemetry values"

        });

      }


      // =================================================
  // INSERT TELEMETRY INTO MYSQL
  // =================================================

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

        VALUES
        (
          ?,
          ?,
          ?,
          ?,
          ?,
          ?,
          ?,
          ?,
          ?,
          UTC_TIMESTAMP()
        )

      `;


      await pool.execute(

        sql,

        [

          deviceIdValue,

          voltageValue,

          currentValue,

          temperatureValue,

          socValue,

          usedAhValue,

          usedWhValue,

          internalResistanceValue,

          gsmSignalValue

        ]

      );


      // =================================================
  // SEND SUCCESS RESPONSE TO ESP32
  //
  // DO NOT WAIT FOR AZURE ML
  // =================================================

      res.status(200).json({

        ok: true,


        message:

          "Data stored",


        received: {


          device_id:

            deviceIdValue,


          voltage:

            voltageValue,


          current:

            currentValue,


          temperature:

            temperatureValue,


          soc:

            socValue,


          used_Ah:

            usedAhValue,


          used_Wh:

            usedWhValue,


          internal_resistance:

            internalResistanceValue,


          gsm_signal:

            gsmSignalValue


        }

      });


      // =================================================
  // START CYCLE-TRIGGERED SOH PROCESSING
  //
  // IMPORTANT:
  //
  // DO NOT USE await HERE.
  //
  // TELEMETRY AND ML REMAIN INDEPENDENT.
  // =================================================

      processCycleTriggeredSOH({

        device_id:

          deviceIdValue,


        voltage:

          voltageValue,


        current:

          currentValue,


        temperature:

          temperatureValue,


        internal_resistance:

          internalResistanceValue,


        used_ah:

          usedAhValue,


        soc:

          socValue,


        used_wh:

          usedWhValue


      }).catch(

        (

          error

        ) => {


          console.error(

            "[SOH] Cycle-triggered prediction failed:",

            error.message

          );


        }

      );


    } catch (

      err

    ) {


      console.error(

        "Insert error:",

        err

      );


      if (

        !res.headersSent

      ) {


        res.status(500).json({

          ok: false,

          error: err.message

        });

      }

    }

  }

);


// =====================================================
// LATEST BATTERY HEALTH API
//
// DASHBOARD USES THIS FOR SOH
// =====================================================

app.get(

  "/api/health/latest",

  async (

    req,

    res

  ) => {


    try {


      const deviceId =

        req.query.device_id ||

        DEVICE_ID;


      const [rows] =

        await pool.query(

          `
          SELECT

            device_id,

            cycle_count,

            soh,

            sol_health_margin,

            model_name,

            updated_at

          FROM battery_health_latest

          WHERE device_id = ?

          LIMIT 1
          `,

          [

            deviceId

          ]

        );


      if (

        rows.length === 0

      ) {


        return res

          .status(404)

          .json({

            ok: false,

            message:

              "No SOH prediction available"

          });

      }


      const row =

        rows[0];


      return res.json({

        ok: true,


        health: {


          device_id:

            row.device_id,


          cycle_count:

            Number(

              row.cycle_count

            ),


          soh:

            Number(

              row.soh

            ),


          sol_health_margin:

            Number(

              row.sol_health_margin

            ),


          model_name:

            row.model_name,


          updated_at:

            row.updated_at


        }

      });


    } catch (

      error

    ) {


      console.error(

        "Health API error:",

        error

      );


      return res

        .status(500)

        .json({

          ok: false,

          message:

            "Failed to retrieve battery health",

          error:

            error.message

        });

    }

  }

);


// =====================================================
// CYCLE-BY-CYCLE SOH HISTORY API
// =====================================================

app.get(

  "/api/health/history",

  async (

    req,

    res

  ) => {


    try {


      const deviceId =

        req.query.device_id ||

        DEVICE_ID;


      const [rows] =

        await pool.query(

          `
          SELECT

            cycle_count,

            soh,

            sol_health_margin,

            model_name,

            predicted_at

          FROM battery_health_history

          WHERE device_id = ?

          ORDER BY cycle_count ASC
          `,

          [

            deviceId

          ]

        );


      return res.json({

        ok: true,


        device_id:

          deviceId,


        count:

          rows.length,


        history:

          rows.map(

            (

              row

            ) => ({

              cycle_count:

                Number(

                  row.cycle_count

                ),


              soh:

                Number(

                  row.soh

                ),


              sol_health_margin:

                Number(

                  row.sol_health_margin

                ),


              model_name:

                row.model_name,


              predicted_at:

                row.predicted_at

            })

          )

      });


    } catch (

      error

    ) {


      console.error(

        "Health history error:",

        error

      );


      return res

        .status(500)

        .json({

          ok: false,

          message:

            "Failed to retrieve SOH history",

          error:

            error.message

        });

    }

  }

);


// =====================================================
// LATEST TELEMETRY API FOR DASHBOARD
//
// LIVE TELEMETRY
// +
// LATEST STORED ML SOH
// =====================================================

app.get(

  "/api/latest",

  async (

    req,

    res

  ) => {


    try {


      const [rows] =

        await pool.query(

          `
          SELECT

            t.device_id,

            t.voltage,

            t.\`current\`
              AS current,

            t.temperature,

            t.soc,

            t.used_Ah,

            t.used_Wh,

            t.internal_resistance,

            t.gsm_signal,

            t.created_at,


            TIMESTAMPDIFF
            (
              SECOND,

              t.created_at,

              UTC_TIMESTAMP()
            )
            AS age_seconds,


            bcs.cycle_count
              AS current_cycle_count,


            bhl.soh
              AS latest_soh,


            bhl.sol_health_margin
              AS latest_sol_health_margin,


            bhl.updated_at
              AS soh_updated_at


          FROM telemetry t


          LEFT JOIN battery_cycle_state bcs

            ON t.device_id =
               bcs.device_id


          LEFT JOIN battery_health_latest bhl

            ON t.device_id =
               bhl.device_id


          WHERE t.device_id = ?


          ORDER BY

            t.created_at DESC


          LIMIT 1
          `,

          [

            DEVICE_ID

          ]

        );


      // =================================================
  // NO TELEMETRY AVAILABLE
  // =================================================

      if (

        rows.length === 0

      ) {


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

          soh: null,

          sol_health_margin: null,

          cycle_count: null,

          estimated_range_km: 0,

          age_seconds: null,

          created_at: null,

          soh_updated_at: null

        });

      }


      const data =

        rows[0];


      const ageSeconds =

        Number(

          data.age_seconds

        );


      // =================================================
  // LATEST ML SOH
  // =================================================

      const latestSOH =

        data.latest_soh !== null &&

        data.latest_soh !== undefined

          ?

          Number(

            data.latest_soh

          )

          :

          null;


      // =================================================
  // LATEST SOL HEALTH MARGIN
  // =================================================

      const latestSOL =

        data.latest_sol_health_margin !== null &&

        data.latest_sol_health_margin !== undefined

          ?

          Number(

            data.latest_sol_health_margin

          )

          :

          null;


      // =================================================
  // CURRENT INTEGER CYCLE COUNT
  // =================================================

      const cycleCount =

        data.current_cycle_count !== null &&

        data.current_cycle_count !== undefined

          ?

          Number(

            data.current_cycle_count

          )

          :

          null;


      // =================================================
  // ESP32 OFFLINE
  //
  // KEEP LATEST ML SOH AVAILABLE
  // =================================================

      if (

        ageSeconds >

        OFFLINE_TIMEOUT_SECONDS

      ) {


        return res.json({

          ok: true,

          online: false,

          status: "OFFLINE",

          device_id:

            data.device_id,

          voltage: 0,

          current: 0,

          temperature: 0,

          soc: 0,

          used_Ah: 0,

          used_Wh: 0,

          internal_resistance: 0,

          gsm_signal: 0,

          soh:

            latestSOH,

          sol_health_margin:

            latestSOL,

          cycle_count:

            cycleCount,

          estimated_range_km: 0,

          age_seconds:

            ageSeconds,

          created_at:

            data.created_at,

          soh_updated_at:

            data.soh_updated_at

        });

      }


      // =================================================
  // ESP32 ONLINE
  // =================================================

      const voltage =

        Number(

          data.voltage

        );


      const current =

        Number(

          data.current

        );


      const temperature =

        Number(

          data.temperature

        );


      const gsmSignal =

        Number(

          data.gsm_signal

        );


      const soc =

        data.soc !== null &&

        data.soc !== undefined

          ?

          Number(

            data.soc

          )

          :

          calculateSOC(

            voltage

          );


      const usedAh =

        data.used_Ah !== null &&

        data.used_Ah !== undefined

          ?

          Number(

            data.used_Ah

          )

          :

          0;


      const usedWh =

        data.used_Wh !== null &&

        data.used_Wh !== undefined

          ?

          Number(

            data.used_Wh

          )

          :

          0;


      const internalResistance =

        data.internal_resistance !== null &&

        data.internal_resistance !== undefined

          ?

          Number(

            data.internal_resistance

          )

          :

          0;


      const estimatedRangeKm =

        calculateEstimatedRange(

          soc

        );


      return res.json({

        ok: true,

        online: true,

        status: "ONLINE",


        device_id:

          data.device_id,


        voltage:

          voltage,


        current:

          current,


        temperature:

          temperature,


        soc:

          soc,


        used_Ah:

          usedAh,


        used_Wh:

          usedWh,


        internal_resistance:

          internalResistance,


        gsm_signal:

          gsmSignal,


        soh:

          latestSOH,


        sol_health_margin:

          latestSOL,


        cycle_count:

          cycleCount,


        estimated_range_km:

          estimatedRangeKm,


        age_seconds:

          ageSeconds,


        created_at:

          data.created_at,


        soh_updated_at:

          data.soh_updated_at

      });


    } catch (

      err

    ) {


      console.error(

        "Latest API error:",

        err

      );


      res.status(500).json({

        ok: false,

        error: err.message

      });

    }

  }

);


// =====================================================
// TELEMETRY HISTORY API FOR DASHBOARD GRAPHS
// =====================================================

app.get(

  "/api/history",

  async (

    req,

    res

  ) => {


    try {


      // =================================================
  // CHECK DEVICE ONLINE/OFFLINE STATUS
  // =================================================

      const [latestRows] =

        await pool.query(

          `
          SELECT

            created_at,


            TIMESTAMPDIFF
            (
              SECOND,

              created_at,

              UTC_TIMESTAMP()
            )
            AS age_seconds


          FROM telemetry


          WHERE device_id = ?


          ORDER BY

            created_at DESC


          LIMIT 1
          `,

          [

            DEVICE_ID

          ]

        );


      let online = false;


      let status =

        "OFFLINE";


      if (

        latestRows.length > 0

      ) {


        const ageSeconds =

          Number(

            latestRows[0].age_seconds

          );


        if (

          ageSeconds <=

          OFFLINE_TIMEOUT_SECONDS

        ) {


          online = true;


          status =

            "ONLINE";

        }

      }


      // =================================================
  // READ LAST 50 REAL TELEMETRY RECORDS
  // =================================================

      const [rows] =

        await pool.query(

          `
          SELECT

            voltage,

            \`current\`
              AS current,

            temperature,

            soc,

            used_Ah,

            used_Wh,

            internal_resistance,

            gsm_signal,

            created_at


          FROM telemetry


          WHERE device_id = ?


          ORDER BY

            created_at DESC


          LIMIT 50
          `,

          [

            DEVICE_ID

          ]

        );


      res.json({

        ok: true,

        online:

          online,

        status:

          status,

        data:

          rows.reverse()

      });


    } catch (

      err

    ) {


      console.error(

        "History API error:",

        err

      );


      res.status(500).json({

        ok: false,

        error: err.message

      });

    }

  }

);


// =====================================================
// START SERVER
// =====================================================

initDb()

  .then(

    () => {


      app.listen(

        PORT,

        () => {


          console.log(

            `Server running on port ${PORT}`

          );


          console.log(

            "SOH mode: one Azure ML inference per new battery cycle"

          );

        }

      );

    }

  )

  .catch(

    (

      err

    ) => {


      console.error(

        "DB init failed:",

        err

      );


      process.exit(1);

    }

  );
