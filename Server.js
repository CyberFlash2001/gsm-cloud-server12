const express = require('express');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

app.get('/', (req, res) => {
  res.send('Server is running');
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.post('/gsm-data', (req, res) => {
  console.log('Received from GSM:', req.body);

  res.json({
    success: true,
    message: 'Data received',
    data: req.body
  });
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});