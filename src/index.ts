import express from 'express';
import cors from 'cors';
import router from './routes.js';

const app = express();
const PORT = process.env.PORT ?? 4000;

app.use(cors());
app.use(express.json());
app.use('/api', router);

// HTML leaderboard page served at /leaderboard
app.get('/leaderboard', (req, res, next) => {
  req.url = '/leaderboard';
  router(req, res, next);
});

app.listen(PORT, () => {
  console.log(`Backend running on http://localhost:${PORT}`);
  console.log(`Leaderboard: http://localhost:${PORT}/leaderboard`);
});
