# Prompt à donner à Cursor

Crée un site web de suivi de courses VTC pour plusieurs chauffeurs, avec un rôle admin qui supervise tout. Voici le cahier des charges complet.

## Stack technique
- Site statique **HTML/CSS/JS vanilla** (pas de framework React/Vue/Next.js), pour un déploiement simple sur **GitHub Pages**
- Base de données : **Firebase Firestore**
- Authentification : **Firebase Authentication** (email/mot de passe)
- Géolocalisation : API Geolocation du navigateur (`navigator.geolocation`), avec `watchPosition` pour le suivi en direct
- Carte : **Leaflet.js + OpenStreetMap** (gratuit, pas de clé API nécessaire) pour afficher la position en temps réel et retracer les trajets
- Interface **mobile-first** pour l'espace chauffeur (utilisée sur téléphone), interface desktop classique pour l'espace admin (utilisé sur PC)

## Configuration Firebase à utiliser
```js
const firebaseConfig = {
  apiKey: "AIzaSyCgaSbAqE7f2KskhAvKqU5Zq8rhXQrhrk8",
  authDomain: "vtc-tracker-318fc.firebaseapp.com",
  projectId: "vtc-tracker-318fc",
  storageBucket: "vtc-tracker-318fc.firebasestorage.app",
  messagingSenderId: "896728030893",
  appId: "1:896728030893:web:d28d910f74e758fe46b024",
  measurementId: "G-HPE7XH1MK4"
};
```

## Rôles

### Admin (un seul compte, moi)
- N'est PAS un chauffeur, n'enregistre pas de courses
- Voit la liste de tous les chauffeurs, leurs stats, leurs courses
- Approuve ou refuse les inscriptions des nouveaux chauffeurs
- Peut modifier l'objectif journalier de chaque chauffeur
- Peut modifier ou supprimer une course en cas d'erreur
- Interface pensée pour desktop

### Chauffeur (plusieurs comptes)
- S'inscrit via email/mot de passe, mais son compte reste **inactif tant que l'admin n'a pas approuvé**
- Une fois approuvé, accède à son tableau de bord
- Démarre/termine sa journée (session)
- Démarre/termine ses courses avec tracking GPS en direct
- Ne voit que ses propres données (jamais celles des autres chauffeurs)
- Interface pensée mobile-first

## Architecture Firestore (collections déjà créées dans la console)

### Collection `chauffeurs`
- `id` (uid Firebase Auth, utilisé comme ID de document)
- `nom` (string)
- `email` (string)
- `objectif_journalier` (number)
- `statut` (string : "en_attente" | "approuve" | "refuse") — **à ajouter**, géré par l'admin
- `role` (string : "chauffeur" | "admin") — **à ajouter**, pour distinguer le compte admin des chauffeurs

### Collection `sessions` (une journée de travail)
- `chauffeur_id` (string, référence au chauffeur)
- `date` (string, format YYYY-MM-DD)
- `heure_debut` (string, format HH:MM)
- `heure_fin` (string, format HH:MM, vide tant que la session est en cours)
- `objectif_du_jour` (number, copié depuis objectif_journalier au moment du démarrage de la session)

### Collection `courses` (chaque trajet effectué)
- `chauffeur_id` (string)
- `session_id` (string, référence à la session en cours)
- `heure_depart_course` (string, HH:MM)
- `heure_arrivee_course` (string, HH:MM)
- `coords_depart` (map: { lat: number, lng: number }, capturé automatiquement au démarrage de la course)
- `coords_arrivee` (map: { lat: number, lng: number }, capturé automatiquement à la fin)
- `distance` (number, en km — **calculée automatiquement** à partir des points GPS accumulés, pas de saisie manuelle)
- `duree` (number, en minutes — calculée automatiquement : heure fin - heure début)
- `prix` (number — **seul champ saisi manuellement par le chauffeur** à la fin de la course)
- `trajet_gps` (array de { lat, lng, timestamp }, capturé pendant toute la course)

## Fonctionnalités détaillées

### 1. Authentification et inscription
- Page d'inscription : nom, email, mot de passe → crée un document `chauffeurs` avec `statut: "en_attente"`, `role: "chauffeur"`
- Le compte admin est créé une seule fois manuellement (à la main dans Firebase, `role: "admin"`)
- À la connexion : si `statut !== "approuve"` et `role !== "admin"` → afficher un message "Votre compte est en attente de validation", pas d'accès au tableau de bord
- Si approuvé → redirection vers le tableau de bord chauffeur
- Si admin → redirection vers le tableau de bord admin

### 2. Espace admin (desktop)
- Liste des chauffeurs avec leur statut (en attente / approuvé / refusé) → boutons Approuver / Refuser
- Pour chaque chauffeur approuvé : voir ses stats (jour/semaine/mois), son historique de courses, modifier son `objectif_journalier`
- Liste de toutes les courses tous chauffeurs confondus, avec bouton "Modifier" (changer prix, distance, etc.) et bouton "Supprimer"
- Vue carte pour visualiser le trajet de n'importe quelle course passée

### 3. Espace chauffeur — session (mobile)
- Bouton "Démarrer ma journée" : crée un document `sessions` (heure_debut = maintenant, objectif_du_jour = objectif_journalier actuel)
- Bouton "Terminer ma journée" : met à jour `heure_fin`
- Un chauffeur ne peut avoir qu'une session active à la fois (vérifier avant d'en créer une nouvelle)

### 4. Espace chauffeur — course avec tracking GPS (mobile)
- Bouton "Démarrer une course" :
  - Demande la permission de géolocalisation
  - Capture la position de départ (`coords_depart`) et l'heure
  - Lance `watchPosition` : chaque nouveau point est ajouté à un tableau JS **en mémoire** (pas d'écriture Firestore à chaque point)
  - Affiche une **carte en direct** (Leaflet) avec la position actuelle qui se met à jour et le tracé du trajet parcouru jusqu'ici
- Bouton "Terminer la course" :
  - Arrête `watchPosition`, capture `coords_arrivee` et l'heure
  - Calcule automatiquement `distance` (somme des distances entre points GPS consécutifs, formule de Haversine) et `duree`
  - Demande uniquement le **prix** au chauffeur (seul champ manuel)
  - Envoie un seul document dans `courses` avec tous les champs, y compris `trajet_gps` complet

### 5. Tableau de bord chauffeur — statistiques (mobile)
- Total gagné aujourd'hui vs `objectif_du_jour` (barre de progression)
- Total de la semaine, total du mois
- Liste des courses du jour, cliquable pour voir le trajet retracé sur une carte
- Nombre de courses, moyenne par course

### 6. Sécurité Firestore (fichier firestore.rules à générer)
- Un chauffeur ne peut lire/écrire que ses propres documents `sessions` et `courses` (chauffeur_id == son uid)
- Un chauffeur ne peut PAS modifier son propre `statut`, `role`, ni `objectif_journalier` (seul l'admin peut)
- L'admin (role == "admin") peut tout lire et tout modifier
- Un chauffeur en attente ou refusé ne peut rien lire/écrire à part son propre document `chauffeurs`

## Structure de fichiers souhaitée
```
index.html              (connexion)
inscription.html        (inscription chauffeur)
dashboard-chauffeur.html
dashboard-admin.html
css/style.css
css/mobile.css
js/firebase-config.js
js/auth.js
js/session.js
js/course.js
js/stats.js
js/admin.js
js/geo-utils.js         (calcul de distance Haversine)
firestore.rules
README.md               (déploiement GitHub Pages)
```

## Ordre de développement souhaité
1. Structure de base + authentification + inscription + statut en attente
2. Espace admin : approbation des chauffeurs + gestion des objectifs
3. Espace chauffeur : session (démarrer/terminer journée)
4. Tracking GPS d'une course (démarrage, carte en direct, fin, calcul distance)
5. Statistiques (chauffeur et admin)
6. Règles de sécurité Firestore

Commence par l'étape 1 uniquement, on avancera étape par étape ensuite.
