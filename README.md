# MathQuiz

Application web légère de quiz de mathématiques : comptes utilisateurs, quiz de 10 questions, historique des scores, classement et administration.

- **Front-end** : HTML5, Bootstrap 5.3 (CDN), JavaScript vanilla (une seule page, navigation par `#/route`).
- **Back-end** : un unique fichier `server.js` en Node.js, **sans aucune dépendance** (modules intégrés `http`, `fs`, `crypto`).
- **Base de données** : `data.json` (utilisateurs, questions, scores).

## Arborescence

```
MathQuiz/
├── server.js        # Serveur HTTP + API JSON + lecture/écriture de data.json
├── data.seed.json   # Base de départ : 30 questions, aucun utilisateur ni score
├── data.json        # Base de données locale (créée au 1er lancement, non versionnée)
├── package.json     # Script "npm start"
├── .gitignore
├── README.md
└── public/
    ├── index.html   # Page unique : toutes les vues (connexion, quiz, scores…)
    ├── style.css    # Thème personnalisé par-dessus Bootstrap
    └── app.js       # Logique côté navigateur
```

## Lancer le projet

Prérequis : [Node.js](https://nodejs.org) 18 ou plus récent.

```bash
cd MathQuiz
npm start          # ou : node server.js
```

Ouvrez ensuite <http://localhost:3000>. Pour changer de port : `PORT=8080 npm start` (sous PowerShell : `$env:PORT=8080; npm start`).

Au premier démarrage, un compte administrateur est créé : **admin / admin123**. Changez son mot de passe depuis la page *Profil*.

> Pourquoi un petit serveur ? Un navigateur ne peut pas écrire dans un fichier du disque. `server.js` sert donc le site et lit/écrit `data.json` pour lui.

## Fonctionnalités

| Fonction | Où |
|---|---|
| Inscription / connexion / déconnexion | Écran d'accueil |
| Quiz de 10 questions aléatoires, par thème ou tous thèmes, chronomètre, retour à la question précédente, raccourcis clavier 1-4 / Entrée | Accueil → *Commencer le quiz* |
| Score final + correction détaillée | Fin du quiz |
| Historique et statistiques personnelles, suppression d'un score | *Mes scores* |
| Classement des joueurs | *Classement* |
| Modification du nom, de l'e-mail et du mot de passe, suppression du compte | *Profil* |
| Liste des utilisateurs, changement de rôle, suppression d'un utilisateur | *Administration* (admins) |

## Choix techniques

- **Cohérence des données** : `data.json` est chargé en mémoire au démarrage. Chaque modification est écrite dans un fichier temporaire, puis renommée, pour ne jamais laisser un fichier à moitié écrit. Node exécute les requêtes une par une, ce qui évite les écritures concurrentes. Supprimer un utilisateur supprime aussi ses scores.
- **Sécurité** : les mots de passe sont hachés (scrypt avec sel), les sessions passent par un jeton (`Authorization: Bearer`), et les bonnes réponses ne sont jamais envoyées au navigateur : le serveur corrige lui-même, ce qui empêche la triche. Le texte saisi par les utilisateurs est échappé à l'affichage.
- Les sessions sont conservées en mémoire : redémarrer le serveur déconnecte tout le monde.

## Ajouter des questions

Arrêtez le serveur, puis ajoutez des objets dans `questions` de `data.json` (et de `data.seed.json` pour qu'ils soient présents sur une nouvelle installation) :

```json
{ "id": "ge7", "category": "Géométrie", "question": "Combien de faces a un cube ?", "choices": ["4", "6", "8", "12"], "answer": 1 }
```

`answer` est l'index (à partir de 0) de la bonne réponse dans `choices`. Une nouvelle `category` apparaît automatiquement dans la liste des thèmes.
