// MathQuiz — serveur minimal sans dépendance (Node.js >= 18)
// Sert les fichiers de /public et expose une API JSON adossée à data.json.
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'data.json');
const SEED_FILE = path.join(__dirname, 'data.seed.json');
const PUBLIC_DIR = path.join(__dirname, 'public');
const QUIZ_SIZE = 10;
const QUIZ_TTL_MS = 2 * 60 * 60 * 1000;

// ---------- Base de données (fichier JSON) ----------
// Les données sont chargées en mémoire au démarrage, puis chaque modification
// est écrite dans un fichier temporaire renommé ensuite : le fichier n'est
// jamais laissé à moitié écrit.
// Au premier lancement, data.json est créé à partir de data.seed.json.
if (!fs.existsSync(DATA_FILE)) fs.copyFileSync(SEED_FILE, DATA_FILE);
let db = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
db.users ??= [];
db.scores ??= [];
db.questions ??= [];

function save() {
  const tmp = DATA_FILE + '.tmp';
  const json = JSON.stringify(db, null, 2);
  fs.writeFileSync(tmp, json);
  // Sous Windows, OneDrive ou l'antivirus peuvent verrouiller brièvement le fichier : on réessaie.
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      return fs.renameSync(tmp, DATA_FILE);
    } catch (err) {
      if (err.code !== 'EPERM' && err.code !== 'EBUSY') throw err;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
  fs.writeFileSync(DATA_FILE, json);
  fs.rmSync(tmp, { force: true });
}

const uid = () => crypto.randomUUID();
const now = () => new Date().toISOString();

// ---------- Mots de passe ----------
function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  return `${salt}:${crypto.scryptSync(password, salt, 64).toString('hex')}`;
}

function checkPassword(password, stored) {
  const [salt, hash] = stored.split(':');
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), crypto.scryptSync(password, salt, 64));
}

// Crée un administrateur par défaut si aucun n'existe.
if (!db.users.some((u) => u.role === 'admin')) {
  db.users.push({ id: uid(), username: 'admin', email: 'admin@mathquiz.local', password: hashPassword('admin123'), role: 'admin', createdAt: now() });
  save();
  console.log('Compte administrateur créé : admin / admin123 (pensez à changer le mot de passe)');
}

// ---------- Sessions et quiz en cours (en mémoire) ----------
const sessions = new Map(); // token -> userId
const pendingQuizzes = new Map(); // quizId -> { userId, questionIds, category, startedAt }

function openSession(user) {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, user.id);
  return { token, user: publicUser(user) };
}

function closeSessionsOf(userId) {
  for (const [token, id] of sessions) if (id === userId) sessions.delete(token);
}

const publicUser = ({ id, username, email, role, createdAt }) => ({ id, username, email, role, createdAt });

// ---------- Utilitaires HTTP ----------
class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const fail = (status, message) => {
  throw new HttpError(status, message);
};

function send(res, status, data) {
  if (status === 204) {
    res.writeHead(204);
    return res.end();
  }
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 1e6) reject(new HttpError(413, 'Requête trop volumineuse.'));
    });
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new HttpError(400, 'JSON invalide.'));
      }
    });
    req.on('error', reject);
  });
}

function authenticate(req) {
  const token = (req.headers.authorization || '').replace(/^Bearer /, '');
  const user = db.users.find((u) => u.id === sessions.get(token));
  if (!user) fail(401, 'Session expirée, veuillez vous reconnecter.');
  return user;
}

function requireAdmin(user) {
  if (user.role !== 'admin') fail(403, 'Accès réservé aux administrateurs.');
}

// ---------- Validation ----------
const USERNAME_RE = /^[\p{L}0-9_.-]{3,20}$/u;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function validateIdentity(username, email, excludeId) {
  if (typeof username !== 'string' || !USERNAME_RE.test(username.trim()))
    fail(400, "Le nom d'utilisateur doit contenir 3 à 20 caractères (lettres, chiffres, . _ -).");
  if (typeof email !== 'string' || !EMAIL_RE.test(email.trim())) fail(400, 'Adresse e-mail invalide.');
  const others = db.users.filter((u) => u.id !== excludeId);
  if (others.some((u) => u.username.toLowerCase() === username.trim().toLowerCase()))
    fail(409, "Ce nom d'utilisateur est déjà pris.");
  if (others.some((u) => u.email === email.trim().toLowerCase())) fail(409, 'Cette adresse e-mail est déjà utilisée.');
}

function validatePassword(password) {
  if (typeof password !== 'string' || password.length < 6) fail(400, 'Le mot de passe doit contenir au moins 6 caractères.');
}

// ---------- Statistiques ----------
function statsFor(userId) {
  const list = db.scores.filter((s) => s.userId === userId);
  const games = list.length;
  return {
    games,
    best: games ? Math.max(...list.map((s) => s.percent)) : 0,
    average: games ? Math.round(list.reduce((sum, s) => sum + s.percent, 0) / games) : 0,
  };
}

function shuffle(array) {
  const a = [...array];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ---------- API ----------
async function handleApi(req, res, url) {
  const { method } = req;
  const p = url.pathname;
  let m;

  // --- Comptes ---
  if (method === 'POST' && p === '/api/register') {
    const { username, email, password } = await readBody(req);
    validateIdentity(username, email);
    validatePassword(password);
    const user = {
      id: uid(),
      username: username.trim(),
      email: email.trim().toLowerCase(),
      password: hashPassword(password),
      role: 'user',
      createdAt: now(),
    };
    db.users.push(user);
    save();
    return send(res, 201, openSession(user));
  }

  if (method === 'POST' && p === '/api/login') {
    const { identifier = '', password = '' } = await readBody(req);
    const id = String(identifier).trim().toLowerCase();
    const user = db.users.find((u) => u.username.toLowerCase() === id || u.email === id);
    if (!user || !checkPassword(String(password), user.password)) fail(401, 'Identifiants incorrects.');
    return send(res, 200, openSession(user));
  }

  if (method === 'POST' && p === '/api/logout') {
    sessions.delete((req.headers.authorization || '').replace(/^Bearer /, ''));
    return send(res, 204);
  }

  // Toutes les routes suivantes nécessitent d'être connecté.
  const user = authenticate(req);

  if (p === '/api/me') {
    if (method === 'GET') return send(res, 200, publicUser(user));

    if (method === 'PUT') {
      const { username, email, newPassword, currentPassword } = await readBody(req);
      validateIdentity(username, email, user.id);
      if (newPassword) {
        validatePassword(newPassword);
        if (!currentPassword || !checkPassword(String(currentPassword), user.password))
          fail(400, 'Mot de passe actuel incorrect.');
        user.password = hashPassword(newPassword);
      }
      user.username = username.trim();
      user.email = email.trim().toLowerCase();
      save();
      return send(res, 200, publicUser(user));
    }

    if (method === 'DELETE') {
      if (user.role === 'admin' && db.users.filter((u) => u.role === 'admin').length === 1)
        fail(400, 'Impossible de supprimer le dernier administrateur.');
      deleteUser(user.id);
      return send(res, 204);
    }
  }

  // --- Quiz ---
  if (method === 'GET' && p === '/api/categories') {
    const counts = {};
    for (const q of db.questions) counts[q.category] = (counts[q.category] || 0) + 1;
    return send(res, 200, Object.entries(counts).map(([name, count]) => ({ name, count })));
  }

  if (method === 'POST' && p === '/api/quiz') {
    const { category = '' } = await readBody(req);
    const pool = category ? db.questions.filter((q) => q.category === category) : db.questions;
    if (!pool.length) fail(404, 'Aucune question dans cette catégorie.');

    for (const [id, quiz] of pendingQuizzes) if (Date.now() - quiz.startedAt > QUIZ_TTL_MS) pendingQuizzes.delete(id);

    const picked = shuffle(pool).slice(0, QUIZ_SIZE);
    const quizId = uid();
    pendingQuizzes.set(quizId, { userId: user.id, questionIds: picked.map((q) => q.id), category, startedAt: Date.now() });
    // Les bonnes réponses ne sont jamais envoyées au navigateur : la correction se fait côté serveur.
    const questions = picked.map(({ id, category, question, choices }) => ({ id, category, question, choices }));
    return send(res, 201, { quizId, questions });
  }

  if (method === 'POST' && (m = p.match(/^\/api\/quiz\/([\w-]+)\/submit$/))) {
    const quiz = pendingQuizzes.get(m[1]);
    if (!quiz || quiz.userId !== user.id) fail(404, 'Quiz introuvable ou expiré.');
    pendingQuizzes.delete(m[1]);

    const { answers = {} } = await readBody(req);
    const corrections = quiz.questionIds.map((qid) => {
      const q = db.questions.find((x) => x.id === qid);
      const given = Number.isInteger(answers[qid]) ? answers[qid] : null;
      return { question: q.question, choices: q.choices, answer: q.answer, given, correct: given === q.answer };
    });
    const score = corrections.filter((c) => c.correct).length;
    const entry = {
      id: uid(),
      userId: user.id,
      category: quiz.category || 'Toutes catégories',
      score,
      total: corrections.length,
      percent: Math.round((score / corrections.length) * 100),
      durationSec: Math.round((Date.now() - quiz.startedAt) / 1000),
      date: now(),
    };
    db.scores.push(entry);
    save();
    return send(res, 201, { ...entry, corrections });
  }

  // --- Scores ---
  if (method === 'GET' && p === '/api/scores') {
    const target = url.searchParams.get('userId') || user.id;
    if (target !== user.id) requireAdmin(user);
    const list = db.scores.filter((s) => s.userId === target).sort((a, b) => b.date.localeCompare(a.date));
    return send(res, 200, list);
  }

  if (method === 'DELETE' && (m = p.match(/^\/api\/scores\/([\w-]+)$/))) {
    const index = db.scores.findIndex((s) => s.id === m[1]);
    if (index === -1) fail(404, 'Score introuvable.');
    if (db.scores[index].userId !== user.id) requireAdmin(user);
    db.scores.splice(index, 1);
    save();
    return send(res, 204);
  }

  if (method === 'GET' && p === '/api/leaderboard') {
    const board = db.users
      .map((u) => ({ id: u.id, username: u.username, ...statsFor(u.id) }))
      .filter((r) => r.games > 0)
      .sort((a, b) => b.average - a.average || b.best - a.best || b.games - a.games)
      .slice(0, 20);
    return send(res, 200, board);
  }

  // --- Administration ---
  if (method === 'GET' && p === '/api/users') {
    requireAdmin(user);
    return send(res, 200, db.users.map((u) => ({ ...publicUser(u), ...statsFor(u.id) })));
  }

  if ((m = p.match(/^\/api\/users\/([\w-]+)$/))) {
    requireAdmin(user);
    const target = db.users.find((u) => u.id === m[1]);
    if (!target) fail(404, 'Utilisateur introuvable.');
    if (target.id === user.id) fail(400, 'Utilisez la page Profil pour modifier votre propre compte.');

    if (method === 'PUT') {
      const { username = target.username, email = target.email, role = target.role } = await readBody(req);
      if (!['user', 'admin'].includes(role)) fail(400, 'Rôle invalide.');
      validateIdentity(username, email, target.id);
      Object.assign(target, { username: username.trim(), email: email.trim().toLowerCase(), role });
      save();
      return send(res, 200, publicUser(target));
    }

    if (method === 'DELETE') {
      deleteUser(target.id);
      return send(res, 204);
    }
  }

  fail(404, 'Route inconnue.');
}

function deleteUser(userId) {
  db.users = db.users.filter((u) => u.id !== userId);
  db.scores = db.scores.filter((s) => s.userId !== userId);
  closeSessionsOf(userId);
  save();
}

// ---------- Fichiers statiques ----------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function serveStatic(res, pathname) {
  const file = path.normalize(path.join(PUBLIC_DIR, decodeURIComponent(pathname === '/' ? '/index.html' : pathname)));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403);
    return res.end();
  }
  fs.readFile(file, (err, content) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Page introuvable');
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(content);
  });
}

// ---------- Serveur ----------
http
  .createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (url.pathname.startsWith('/api/')) await handleApi(req, res, url);
      else serveStatic(res, url.pathname);
    } catch (err) {
      if (!(err instanceof HttpError)) console.error(err);
      send(res, err.status || 500, { error: err instanceof HttpError ? err.message : 'Erreur interne du serveur.' });
    }
  })
  .listen(PORT, () => console.log(`MathQuiz démarré sur http://localhost:${PORT}`));
