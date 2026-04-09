const express = require('express');

const app = express();
const PORT = process.env.PORT || 3000;

// Accept all incoming bodies as text for debugging
app.use(express.text({ type: '*/*' }));

// Log every request
app.use((req, res, next) => {
  console.log('----------------------------------------');
  console.log('Time:', new Date().toISOString());
  console.log('Method:', req.method);
  console.log('URL:', req.originalUrl);
  console.log('Content-Type:', req.headers['content-type'] || 'none');
  console.log('Body:', req.body);
  next();
});

app.get('/', (req, res) => {
  res.send('Server is running');
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.post('/gsm-data', (req, res) => {
  console.log('Received GSM data on /gsm-data:', req.body);

  res.json({
    success: true,
    message: 'Data received successfully',
    received: req.body
  });
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
