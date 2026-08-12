# VTC Tracker

Site web de suivi de courses VTC pour plusieurs chauffeurs, avec un rôle admin qui supervise tout.

## Déploiement sur GitHub Pages

1.  Assurez-vous que votre code est dans la branche `main` (ou `master`).
2.  Allez dans les `Settings` de votre dépôt GitHub.
3.  Naviguez vers la section `Pages` dans le menu de gauche.
4.  Sous "Build and deployment", sélectionnez la source `Deploy from a branch`.
5.  Choisissez la branche `main` et le dossier `/ (root)`.
6.  Cliquez sur `Save`.

Votre site sera déployé à une adresse du type `https://<votre-username>.github.io/<nom-du-repo>/`.

**Note importante** : Pour que Firebase fonctionne sur GitHub Pages, vous devez ajouter le domaine de votre page (`<votre-username>.github.io`) à la liste des domaines autorisés dans la console Firebase, sous `Authentication` > `Settings` > `Authorized domains`.