const https = require("https");


function postJson(urlString, headers, body) {
  return new Promise((resolve, reject) => {
    try {
      const url = new URL(urlString);

      const payload =
        JSON.stringify(body);

      const options = {
        hostname: url.hostname,

        port: 443,

        path:
          `${url.pathname}${url.search}`,

        method: "POST",

        headers: {
          "Content-Type":
            "application/json",

          "Content-Length":
            Buffer.byteLength(payload),

          ...headers
        }
      };


      const request =
        https.request(
          options,
          (response) => {

            let responseText = "";


            response.on(
              "data",
              (chunk) => {

                responseText += chunk;

              }
            );


            response.on(
              "end",
              () => {

                const statusCode =
                  response.statusCode || 500;


                if (
                  statusCode < 200 ||
                  statusCode >= 300
                ) {

                  return reject(
                    new Error(
                      `Azure ML HTTP ` +
                      `${statusCode}: ` +
                      responseText
                    )
                  );

                }


                try {

                  resolve(
                    JSON.parse(responseText)
                  );

                } catch (error) {

                  reject(
                    new Error(
                      "Invalid Azure ML JSON: " +
                      responseText
                    )
                  );

                }

              }
            );

          }
        );


      request.on(
        "error",
        reject
      );


      request.write(payload);

      request.end();


    } catch (error) {

      reject(error);

    }
  });
}


async function predictSOHFromAzureML(
  features
) {

  const scoringUri =
    process.env.AZURE_ML_SCORING_URI;


  const apiKey =
    process.env.AZURE_ML_API_KEY;


  if (!scoringUri) {

    throw new Error(
      "AZURE_ML_SCORING_URI is missing"
    );

  }


  if (!apiKey) {

    throw new Error(
      "AZURE_ML_API_KEY is missing"
    );

  }


  const data = {

    cycle_count:
      Number(features.cycle_count),

    voltage:
      Number(features.voltage),

    current:
      Number(features.current),

    temperature:
      Number(features.temperature),

    internal_resistance:
      Number(
        features.internal_resistance
      ),

    used_ah:
      Number(features.used_ah),

    soc:
      Number(features.soc),

    used_wh:
      Number(features.used_wh)

  };


  for (
    const [featureName, featureValue]
    of Object.entries(data)
  ) {

    if (!Number.isFinite(featureValue)) {

      throw new Error(
        `Invalid ML feature ` +
        `${featureName}: ` +
        `${featureValue}`
      );

    }

  }


  const result = await postJson(

    scoringUri,

    {
      Authorization:
        `Bearer ${apiKey}`
    },

    {
      data
    }

  );


  if (
    !result.ok ||
    !Array.isArray(result.predictions) ||
    result.predictions.length === 0
  ) {

    throw new Error(
      "Azure ML prediction failed: " +
      JSON.stringify(result)
    );

  }


  return result.predictions[0];
}


module.exports = {
  predictSOHFromAzureML
};
