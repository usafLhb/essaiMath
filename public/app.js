// MathQuiz — logique côté navigateur (JavaScript vanilla, page unique)
'use strict';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fmtDate = (iso) => new Date(iso).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' });
const fmtDuration = (s) => (s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, '0')}`);
const pctBadge = (p) => `<span class="pct ${p >= 70 ? 'pct-high' : p >= 50 ? 'pct-mid' : 'pct-low'}">${p} %</span>`;

const state = { token: localStorage.getItem('mq_token'), user: null, quiz: null, result: null, timer: null };

// ---------- API ----------
async function api(method, url, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (state.token) headers.Authorization = `Bearer ${state.token}`;
  const res = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const data = res.status === 204 ? null : await res.json().catch(() => null);
  if (res.status === 401 && state.user) logoutLocal();
  if (!res.ok) throw new Error(data?.error || `Erreur ${res.status}`);
  return data;
}

// ---------- Interface ----------
function toast(message, type = 'success') {
  const el = document.createElement('div');
  el.className = `toast-msg toast-${type}`;
  el.textContent = message;
  $('#toasts').append(el);
  setTimeout(() => el.classList.add('hide'), 2800);
  setTimeout(() => el.remove(), 3200);
}

// Exécute une action asynchrone en affichant les erreurs dans une notification.
const guard = (fn) => async (...args) => {
  try {
    await fn(...args);
  } catch (err) {
    toast(err.message, 'danger');
  }
};

// Désactive le bouton d'envoi du formulaire pendant la requête.
const busy = (fn) => guard(async (e) => {
  e.preventDefault();
  const btn = $('[type=submit]', e.target);
  btn.disabled = true;
  try {
    await fn(e.target);
  } finally {
    btn.disabled = false;
  }
});

const confirmModal = $('#confirmModal');
let onConfirm = null;
function confirmAction(title, text, action) {
  $('#confirmTitle').textContent = title;
  $('#confirmText').textContent = text;
  onConfirm = action;
  bootstrap.Modal.getOrCreateInstance(confirmModal).show();
}
$('#confirmOk').addEventListener('click', guard(async () => {
  bootstrap.Modal.getOrCreateInstance(confirmModal).hide();
  if (onConfirm) await onConfirm();
}));

function statCards(scores) {
  const games = scores.length;
  const avg = games ? Math.round(scores.reduce((s, x) => s + x.percent, 0) / games) : 0;
  const best = games ? Math.max(...scores.map((x) => x.percent)) : 0;
  const correct = scores.reduce((s, x) => s + x.score, 0);
  return [
    ['Quiz joués', games],
    ['Moyenne', `${avg} %`],
    ['Meilleur score', `${best} %`],
    ['Bonnes réponses', correct],
  ].map(([label, value]) => `
    <div class="col-6 col-lg-3"><div class="card stat-card h-100"><div class="card-body">
      <div class="label">${label}</div><div class="value">${value}</div>
    </div></div></div>`).join('');
}

const emptyBlock = (text) => `<div class="empty">${text}</div>`;

// ---------- Session ----------
function setSession({ token, user }) {
  state.token = token;
  state.user = user;
  localStorage.setItem('mq_token', token);
}

function logoutLocal() {
  stopTimer();
  Object.assign(state, { token: null, user: null, quiz: null, result: null });
  localStorage.removeItem('mq_token');
  route();
}

$('#logoutBtn').addEventListener('click', () => {
  api('POST', '/api/logout').catch(() => {});
  logoutLocal();
  toast('À bientôt !');
});

// ---------- Routage (#/vue) ----------
const views = {
  home: renderHome,
  quiz: renderQuestion,
  result: renderResult,
  scores: renderScores,
  leaderboard: renderLeaderboard,
  profile: renderProfile,
  admin: renderAdmin,
};

function go(view) {
  if (location.hash === `#/${view}`) route();
  else location.hash = `#/${view}`;
}

async function route() {
  let name = location.hash.slice(2) || 'home';
  if (!state.user) name = 'auth';
  else if (
    !views[name] ||
    (name === 'quiz' && !state.quiz) ||
    (name === 'result' && !state.result) ||
    (name === 'admin' && state.user.role !== 'admin')
  ) return go('home');

  // Quitter la page du quiz abandonne le quiz en cours.
  if (name !== 'quiz' && state.quiz) {
    stopTimer();
    state.quiz = null;
  }

  $$('[data-view]').forEach((s) => (s.hidden = s.dataset.view !== name));
  $('#nav').hidden = name === 'auth';
  $$('[data-nav]').forEach((a) => a.classList.toggle('active', a.dataset.nav === name));
  const menu = $('#navMenu');
  if (menu.classList.contains('show')) bootstrap.Collapse.getOrCreateInstance(menu).hide();
  if (state.user) {
    $('#navUser').textContent = state.user.username;
    $('#navAvatar').textContent = state.user.username[0];
    $('#navAdmin').hidden = state.user.role !== 'admin';
  }
  window.scrollTo(0, 0);
  if (views[name]) await guard(views[name])();
}
window.addEventListener('hashchange', route);

// ---------- Connexion / inscription ----------
$$('[data-tab]').forEach((tab) =>
  tab.addEventListener('click', () => {
    $$('[data-tab]').forEach((t) => t.classList.toggle('active', t === tab));
    $('#loginForm').hidden = tab.dataset.tab !== 'login';
    $('#registerForm').hidden = tab.dataset.tab !== 'register';
  })
);

$('#loginForm').addEventListener('submit', busy(async (f) => {
  setSession(await api('POST', '/api/login', { identifier: f.identifier.value, password: f.password.value }));
  f.reset();
  toast(`Bienvenue, ${state.user.username} !`);
  go('home');
}));

$('#registerForm').addEventListener('submit', busy(async (f) => {
  if (f.password.value !== f.confirm.value) throw new Error('Les mots de passe ne correspondent pas.');
  setSession(await api('POST', '/api/register', { username: f.username.value, email: f.email.value, password: f.password.value }));
  f.reset();
  toast('Compte créé, bienvenue !');
  go('home');
}));

// ---------- Accueil ----------
async function renderHome() {
  $('#homeName').textContent = state.user.username;
  const [categories, scores] = await Promise.all([api('GET', '/api/categories'), api('GET', '/api/scores')]);
  const total = categories.reduce((s, c) => s + c.count, 0);
  const select = $('#catSelect');
  const previous = select.value;
  select.innerHTML = `<option value="">Toutes les catégories (${total} questions)</option>` +
    categories.map((c) => `<option value="${esc(c.name)}">${esc(c.name)} (${c.count})</option>`).join('');
  select.value = previous;
  $('#homeStats').innerHTML = statCards(scores);
  $('#homeRecent').innerHTML = scores.length
    ? `<div class="list-group list-group-flush">${scores.slice(0, 5).map((s) => `
        <div class="list-group-item px-0 d-flex justify-content-between align-items-center gap-2">
          <div><div class="fw-semibold">${esc(s.category)}</div><div class="small text-secondary">${fmtDate(s.date)} · ${fmtDuration(s.durationSec)}</div></div>
          <div class="text-end"><span class="fw-bold me-2">${s.score}/${s.total}</span>${pctBadge(s.percent)}</div>
        </div>`).join('')}</div>`
    : emptyBlock('Aucun quiz pour le moment. Lance ton premier défi ! 🚀');
}

$('#startQuiz').addEventListener('click', guard(async (e) => {
  e.target.disabled = true;
  try {
    const data = await api('POST', '/api/quiz', { category: $('#catSelect').value });
    state.quiz = { ...data, index: 0, answers: {}, startedAt: Date.now() };
    startTimer();
    go('quiz');
  } finally {
    e.target.disabled = false;
  }
}));

// ---------- Quiz ----------
function startTimer() {
  stopTimer();
  const tick = () => {
    if (!state.quiz) return;
    const s = Math.floor((Date.now() - state.quiz.startedAt) / 1000);
    $('#qTimer').textContent = `⏱ ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  };
  tick();
  state.timer = setInterval(tick, 1000);
}

function stopTimer() {
  clearInterval(state.timer);
  state.timer = null;
}

function renderQuestion() {
  const q = state.quiz;
  const n = q.questions.length;
  const cur = q.questions[q.index];
  const chosen = q.answers[cur.id];
  $('#qCounter').textContent = `Question ${q.index + 1} / ${n}`;
  $('#qProgress').style.width = `${((q.index + 1) / n) * 100}%`;
  $('#qCategory').textContent = cur.category;
  $('#qText').textContent = cur.question;
  $('#qChoices').innerHTML = cur.choices.map((c, i) => `
    <div class="col-sm-6">
      <button type="button" class="choice${chosen === i ? ' selected' : ''}" data-i="${i}" aria-pressed="${chosen === i}">
        <span class="choice-key">${'ABCD'[i]}</span><span>${esc(c)}</span>
      </button>
    </div>`).join('');
  $('#prevBtn').disabled = q.index === 0;
  $('#nextBtn').disabled = chosen === undefined;
  $('#nextBtn').textContent = q.index === n - 1 ? 'Terminer ✓' : 'Suivant →';
}

function selectChoice(i) {
  const q = state.quiz;
  const cur = q.questions[q.index];
  if (i < 0 || i >= cur.choices.length) return;
  q.answers[cur.id] = i;
  renderQuestion();
}

const nextQuestion = guard(async () => {
  const q = state.quiz;
  if (!q || q.answers[q.questions[q.index].id] === undefined) return;
  if (q.index < q.questions.length - 1) {
    q.index++;
    return renderQuestion();
  }
  $('#nextBtn').disabled = true;
  try {
    state.result = await api('POST', `/api/quiz/${q.quizId}/submit`, { answers: q.answers });
  } catch (err) {
    $('#nextBtn').disabled = false;
    throw err;
  }
  stopTimer();
  state.quiz = null;
  go('result');
});

$('#qChoices').addEventListener('click', (e) => {
  const btn = e.target.closest('.choice');
  if (btn) selectChoice(Number(btn.dataset.i));
});
$('#nextBtn').addEventListener('click', nextQuestion);
$('#prevBtn').addEventListener('click', () => {
  if (state.quiz.index > 0) {
    state.quiz.index--;
    renderQuestion();
  }
});
$('#quitQuiz').addEventListener('click', () =>
  confirmAction('Abandonner le quiz ?', 'Votre progression sur ce quiz sera perdue.', () => go('home'))
);

document.addEventListener('keydown', (e) => {
  if (!state.quiz || $('[data-view="quiz"]').hidden || confirmModal.classList.contains('show')) return;
  if (e.key >= '1' && e.key <= '4') selectChoice(Number(e.key) - 1);
  else if ('abcd'.includes(e.key.toLowerCase()) && e.key.length === 1) selectChoice('abcd'.indexOf(e.key.toLowerCase()));
  else if (e.key === 'Enter' && !e.target.closest('button')) nextQuestion();
});

// ---------- Résultat ----------
function renderResult() {
  const r = state.result;
  const [title, color] =
    r.percent >= 90 ? ['Excellent ! 🏆', 'var(--mq-success)'] :
    r.percent >= 70 ? ['Très bien ! 🎉', 'var(--mq-success)'] :
    r.percent >= 50 ? ['Pas mal ! 👍', 'var(--mq-warning)'] :
    ['Continue à t\'entraîner ! 💪', 'var(--mq-danger)'];
  const ring = $('#rRing');
  ring.style.setProperty('--p', r.percent);
  ring.style.setProperty('--ring', color);
  $('#rPercent').textContent = `${r.percent} %`;
  $('#rTitle').textContent = title;
  $('#rSub').textContent = `${r.score} bonne${r.score > 1 ? 's' : ''} réponse${r.score > 1 ? 's' : ''} sur ${r.total} · ${r.category} ·${fmtDuration(r.durationSec)}`;
  $('#rCorrections').innerHTML = r.corrections.map((c, i) => `
    <div class="correction ${c.correct ? 'ok' : 'ko'}">
      <div class="fw-semibold mb-1">${i + 1}. ${esc(c.question)}</div>
      <div class="small">
        ${c.correct
          ? `<span class="text-success fw-semibold">✓ ${esc(c.choices[c.answer])}</span>`
          : `<span class="text-danger">✗ Votre réponse : ${c.given === null ? '—' : esc(c.choices[c.given])}</span>
             <span class="mx-1 text-secondary">·</span><span class="text-success fw-semibold">Bonne réponse : ${esc(c.choices[c.answer])}</span>`}
      </div>
    </div>`).join('');
}

// ---------- Historique ----------
async function renderScores() {
  const scores = await api('GET', '/api/scores');
  $('#scoreStats').innerHTML = statCards(scores);
  $('#scoreTable').innerHTML = scores.length
    ? `<div class="table-responsive"><table class="table">
        <thead><tr><th>Date</th><th>Catégorie</th><th>Score</th><th>Réussite</th><th class="d-none d-sm-table-cell">Durée</th><th></th></tr></thead>
        <tbody>${scores.map((s) => `
          <tr>
            <td class="text-nowrap">${fmtDate(s.date)}</td>
            <td>${esc(s.category)}</td>
            <td class="fw-bold">${s.score}/${s.total}</td>
            <td>${pctBadge(s.percent)}</td>
            <td class="d-none d-sm-table-cell text-secondary">${fmtDuration(s.durationSec)}</td>
            <td class="text-end"><button class="btn btn-sm btn-outline-danger" data-del-score="${s.id}" aria-label="Supprimer ce score">Supprimer</button></td>
          </tr>`).join('')}</tbody>
      </table></div>`
    : emptyBlock('Aucun score enregistré. <a href="#/home">Lance un quiz</a> !');
}

$('#scoreTable').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-del-score]');
  if (!btn) return;
  confirmAction('Supprimer ce score ?', 'Ce résultat sera retiré de votre historique.', async () => {
    await api('DELETE', `/api/scores/${btn.dataset.delScore}`);
    toast('Score supprimé.');
    renderScores();
  });
});

// ---------- Classement ----------
async function renderLeaderboard() {
  const board = await api('GET', '/api/leaderboard');
  const medals = ['🥇', '🥈', '🥉'];
  $('#boardTable').innerHTML = board.length
    ? `<div class="table-responsive"><table class="table">
        <thead><tr><th>#</th><th>Joueur</th><th>Moyenne</th><th>Meilleur</th><th>Quiz</th></tr></thead>
        <tbody>${board.map((r, i) => `
          <tr class="${r.id === state.user.id ? 'row-me' : ''}">
            <td>${i < 3 ? `<span class="medal">${medals[i]}</span>` : `<span class="text-secondary fw-semibold">${i + 1}</span>`}</td>
            <td class="fw-semibold">${esc(r.username)}${r.id === state.user.id ? ' <span class="badge-soft">vous</span>' : ''}</td>
            <td>${pctBadge(r.average)}</td>
            <td class="fw-semibold">${r.best} %</td>
            <td class="text-secondary">${r.games}</td>
          </tr>`).join('')}</tbody>
      </table></div>`
    : emptyBlock('Personne n\'a encore joué. Soyez le premier !');
}

// ---------- Profil ----------
function renderProfile() {
  const f = $('#profileForm');
  f.reset();
  f.username.value = state.user.username;
  f.email.value = state.user.email;
}

$('#profileForm').addEventListener('submit', busy(async (f) => {
  state.user = await api('PUT', '/api/me', {
    username: f.username.value,
    email: f.email.value,
    currentPassword: f.currentPassword.value,
    newPassword: f.newPassword.value,
  });
  toast('Profil mis à jour.');
  route();
}));

$('#deleteAccount').addEventListener('click', () =>
  confirmAction('Supprimer votre compte ?', 'Cette action est irréversible : votre compte et tous vos scores seront effacés.', async () => {
    await api('DELETE', '/api/me');
    logoutLocal();
    toast('Compte supprimé.');
  })
);

// ---------- Administration ----------
async function renderAdmin() {
  const users = await api('GET', '/api/users');
  $('#adminTable').innerHTML = `<div class="table-responsive"><table class="table">
    <thead><tr><th>Utilisateur</th><th>E-mail</th><th>Rôle</th><th>Quiz</th><th>Moyenne</th><th>Inscrit le</th><th></th></tr></thead>
    <tbody>${users.map((u) => {
      const me = u.id === state.user.id;
      return `<tr>
        <td class="fw-semibold">${esc(u.username)}</td>
        <td class="text-secondary">${esc(u.email)}</td>
        <td>${me
          ? '<span class="badge-soft">admin (vous)</span>'
          : `<select class="form-select form-select-sm w-auto" data-role="${u.id}">
               <option value="user"${u.role === 'user' ? ' selected' : ''}>Utilisateur</option>
               <option value="admin"${u.role === 'admin' ? ' selected' : ''}>Admin</option>
             </select>`}</td>
        <td>${u.games}</td>
        <td>${u.games ? pctBadge(u.average) : '<span class="text-secondary">—</span>'}</td>
        <td class="text-nowrap text-secondary">${new Date(u.createdAt).toLocaleDateString('fr-FR')}</td>
        <td class="text-end">${me ? '' : `<button class="btn btn-sm btn-outline-danger" data-del-user="${u.id}" data-name="${esc(u.username)}">Supprimer</button>`}</td>
      </tr>`;
    }).join('')}</tbody>
  </table></div>`;
}

$('#adminTable').addEventListener('change', guard(async (e) => {
  const sel = e.target.closest('[data-role]');
  if (!sel) return;
  try {
    await api('PUT', `/api/users/${sel.dataset.role}`, { role: sel.value });
    toast('Rôle mis à jour.');
  } finally {
    renderAdmin();
  }
}));

$('#adminTable').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-del-user]');
  if (!btn) return;
  confirmAction(`Supprimer ${btn.dataset.name} ?`, 'Le compte et tous ses scores seront définitivement effacés.', async () => {
    await api('DELETE', `/api/users/${btn.dataset.delUser}`);
    toast('Utilisateur supprimé.');
    renderAdmin();
  });
});

// ---------- Démarrage ----------
(async function init() {
  if (state.token) {
    try {
      state.user = await api('GET', '/api/me');
    } catch {
      state.token = null;
      localStorage.removeItem('mq_token');
    }
  }
  route();
})();
