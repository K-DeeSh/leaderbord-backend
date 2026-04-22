import { Router, Request, Response } from 'express';
import { randomBytes } from 'crypto';
import db from './db.js';

const router = Router();

const VALID_GAMES = ['cto_simulator', 'last_mile_collapse', 'nu_pogodi'];

const GAME_LABELS: Record<string, string> = {
  cto_simulator: 'CTO Simulator',
  last_mile_collapse: 'Last Mile Collapse',
  nu_pogodi: 'Ну погоди!',
};

// Anti-cheat config per game
const MIN_PLAY_SECONDS: Record<string, number> = {
  cto_simulator: 20,
  last_mile_collapse: 20,
  nu_pogodi: 5,
};

const MAX_SCORE: Record<string, number> = {
  cto_simulator: 1000,
  last_mile_collapse: 250,
  nu_pogodi: Infinity, // checked dynamically via elapsed time
};

const MAX_SCORE_PER_SECOND_NU_POGODI = 100;
const SESSION_TTL_SECONDS = 2 * 60 * 60; // 2 hours

// POST /api/session/start — issue a game session token
router.post('/session/start', (req: Request, res: Response) => {
  const { game_id } = req.body;
  if (!game_id || !VALID_GAMES.includes(game_id)) {
    return res.status(400).json({ error: 'Invalid game_id' });
  }

  const token = randomBytes(24).toString('hex');
  const now = Math.floor(Date.now() / 1000);

  db.prepare('INSERT INTO sessions (token, game_id, created_at) VALUES (?, ?, ?)').run(token, game_id, now);

  // Clean up stale sessions (fire-and-forget)
  db.prepare('DELETE FROM sessions WHERE created_at < ?').run(now - SESSION_TTL_SECONDS);

  return res.json({ token });
});

// POST /api/scores — submit game result
router.post('/scores', (req: Request, res: Response) => {
  const { game_id, login, score, victory, archetype, difficulty, turns, duration_seconds, metrics, stats, token } = req.body;

  if (!game_id || !VALID_GAMES.includes(game_id)) {
    return res.status(400).json({ error: 'Invalid game_id' });
  }
  if (!login || typeof login !== 'string' || login.trim().length === 0) {
    return res.status(400).json({ error: 'login is required' });
  }
  if (typeof score !== 'number') {
    return res.status(400).json({ error: 'score must be a number' });
  }

  const now = Math.floor(Date.now() / 1000);
  let isSuspicious = 0;
  const reasons: string[] = [];

  // --- Anti-cheat checks ---

  let elapsedSeconds = 0;

  if (!token) {
    isSuspicious = 1;
    reasons.push('no_token');
  } else {
    const session = db.prepare('SELECT game_id, created_at FROM sessions WHERE token = ?').get(token) as
      | { game_id: string; created_at: number }
      | undefined;

    if (!session) {
      isSuspicious = 1;
      reasons.push('invalid_token');
    } else {
      // Consume token (one-time use)
      db.prepare('DELETE FROM sessions WHERE token = ?').run(token);

      elapsedSeconds = now - session.created_at;

      if (session.game_id !== game_id) {
        isSuspicious = 1;
        reasons.push('game_id_mismatch');
      }

      if (elapsedSeconds > SESSION_TTL_SECONDS) {
        isSuspicious = 1;
        reasons.push('token_expired');
      }

      if (elapsedSeconds < MIN_PLAY_SECONDS[game_id]) {
        isSuspicious = 1;
        reasons.push(`too_fast:${elapsedSeconds}s`);
      }
    }
  }

  // Score plausibility
  const roundedScore = Math.round(score);
  if (game_id === 'nu_pogodi') {
    const maxAllowed = elapsedSeconds * MAX_SCORE_PER_SECOND_NU_POGODI;
    if (roundedScore > maxAllowed && maxAllowed > 0) {
      isSuspicious = 1;
      reasons.push(`score_too_high:${roundedScore}>max${maxAllowed}`);
    }
  } else if (roundedScore > MAX_SCORE[game_id]) {
    isSuspicious = 1;
    reasons.push(`score_too_high:${roundedScore}>max${MAX_SCORE[game_id]}`);
  }

  const result = db.prepare(`
    INSERT INTO scores (game_id, login, score, victory, archetype, difficulty, turns, duration_seconds, metrics, stats, is_suspicious, suspicious_reason)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    game_id,
    login.trim(),
    roundedScore,
    victory === true ? 1 : victory === false ? 0 : null,
    archetype ?? null,
    difficulty ?? null,
    turns ?? null,
    duration_seconds ?? null,
    metrics ? JSON.stringify(metrics) : null,
    stats ? JSON.stringify(stats) : null,
    isSuspicious,
    reasons.length ? reasons.join(',') : null,
  );

  return res.json({ id: result.lastInsertRowid, suspicious: isSuspicious === 1 });
});

// GET /api/leaderboard/:gameId — top scores for one game
router.get('/leaderboard/:gameId', (req: Request, res: Response) => {
  const { gameId } = req.params;
  if (!VALID_GAMES.includes(gameId)) {
    return res.status(400).json({ error: 'Invalid gameId' });
  }

  const limit = Math.min(parseInt(String(req.query.limit ?? '10'), 10) || 10, 100);
  const showAll = req.query.all === '1';

  const suspiciousFilter = showAll ? '' : 'AND (is_suspicious = 0 OR is_suspicious IS NULL)';

  const rows = db.prepare(`
    SELECT login, MAX(score) as score, archetype, difficulty, turns, duration_seconds, victory, created_at
    FROM scores
    WHERE game_id = ? ${suspiciousFilter}
    GROUP BY login
    ORDER BY score DESC
    LIMIT ?
  `).all(gameId, limit);

  return res.json(rows);
});

// GET /api/leaderboard — top scores for all games
router.get('/leaderboard', (_req: Request, res: Response) => {
  const result: Record<string, unknown[]> = {};
  for (const gameId of VALID_GAMES) {
    result[gameId] = db.prepare(`
      SELECT login, MAX(score) as score, archetype, difficulty, turns, duration_seconds, victory, created_at
      FROM scores
      WHERE game_id = ? AND (is_suspicious = 0 OR is_suspicious IS NULL)
      GROUP BY login
      ORDER BY score DESC
      LIMIT 10
    `).all(gameId);
  }
  return res.json(result);
});

// GET /leaderboard — HTML page (mounted at root, not /api)
router.get('/leaderboard', (_req: Request, res: Response) => {
  const allData: Record<string, unknown[]> = {};
  for (const gameId of VALID_GAMES) {
    allData[gameId] = db.prepare(`
      SELECT login, MAX(score) as score, archetype, difficulty, turns, duration_seconds, victory, created_at
      FROM scores
      WHERE game_id = ? AND (is_suspicious = 0 OR is_suspicious IS NULL)
      GROUP BY login
      ORDER BY score DESC
      LIMIT 10
    `).all(gameId);
  }

  const tableRows = (gameId: string) => {
    const rows = allData[gameId] as Array<Record<string, unknown>>;
    if (rows.length === 0) return '<tr><td colspan="5" class="empty">Нет результатов</td></tr>';
    return rows.map((r, i) => {
      const victory = r.victory === 1 ? '✅' : r.victory === 0 ? '💀' : '—';
      const extra = r.archetype ? `<span class="archetype">${r.archetype}</span>` : '';
      const duration = r.turns ? `${r.turns} ходов` : r.duration_seconds ? `${r.duration_seconds}с` : '—';
      return `<tr class="${i < 3 ? 'top' + (i + 1) : ''}">
        <td class="rank">${i + 1}</td>
        <td class="login">${escapeHtml(String(r.login))}${extra}</td>
        <td class="score">${Number(r.score).toLocaleString('ru')}</td>
        <td>${duration}</td>
        <td>${victory}</td>
      </tr>`;
    }).join('');
  };

  const html = `<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>🏆 Лидерборд — Vibecoding Games</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { background: #0a0a0f; color: #e0e0e0; font-family: 'Segoe UI', system-ui, sans-serif; min-height: 100vh; padding: 2rem 1rem; }
    h1 { text-align: center; font-size: 2rem; margin-bottom: 0.5rem; color: #fff; }
    .subtitle { text-align: center; color: #666; margin-bottom: 2.5rem; font-size: 0.9rem; }
    .games { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 2rem; max-width: 1200px; margin: 0 auto; }
    .game-card { background: #13131a; border: 1px solid #2a2a3a; border-radius: 12px; overflow: hidden; }
    .game-header { padding: 1rem 1.25rem; border-bottom: 1px solid #2a2a3a; }
    .game-header h2 { font-size: 1.1rem; color: #fff; }
    .game-header .game-id { font-size: 0.75rem; color: #555; margin-top: 2px; }
    table { width: 100%; border-collapse: collapse; }
    th { padding: 0.6rem 1rem; text-align: left; font-size: 0.75rem; color: #555; text-transform: uppercase; letter-spacing: 0.05em; border-bottom: 1px solid #1e1e2a; }
    td { padding: 0.65rem 1rem; font-size: 0.9rem; border-bottom: 1px solid #1a1a24; }
    tr:last-child td { border-bottom: none; }
    .rank { color: #555; font-size: 0.8rem; width: 2rem; }
    .top1 .rank { color: #ffd700; font-weight: bold; }
    .top2 .rank { color: #c0c0c0; font-weight: bold; }
    .top3 .rank { color: #cd7f32; font-weight: bold; }
    .top1 .login { color: #ffd700; }
    .top2 .login { color: #c0c0c0; }
    .top3 .login { color: #cd7f32; }
    .score { font-weight: bold; color: #7c6af7; }
    .archetype { display: block; font-size: 0.7rem; color: #666; margin-top: 2px; }
    .empty { text-align: center; color: #444; padding: 2rem; }
    .refresh { text-align: center; margin-top: 2rem; }
    .refresh a { color: #7c6af7; text-decoration: none; font-size: 0.85rem; }
    .refresh a:hover { text-decoration: underline; }
  </style>
</head>
<body>
  <h1>🏆 Лидерборд</h1>
  <p class="subtitle">Только честные результаты · ${new Date().toLocaleString('ru')}</p>
  <div class="games">
    ${VALID_GAMES.map(gameId => `
    <div class="game-card">
      <div class="game-header">
        <h2>${GAME_LABELS[gameId]}</h2>
        <div class="game-id">${gameId}</div>
      </div>
      <table>
        <thead><tr><th>#</th><th>Игрок</th><th>Счёт</th><th>Длит.</th><th>Итог</th></tr></thead>
        <tbody>${tableRows(gameId)}</tbody>
      </table>
    </div>`).join('')}
  </div>
  <div class="refresh"><a href="/leaderboard">↺ Обновить</a></div>
</body>
</html>`;

  return res.send(html);
});

function escapeHtml(s: string) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export default router;
