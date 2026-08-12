document.addEventListener('DOMContentLoaded', () => {
    const auth = firebase.auth();
    const db = firebase.firestore();

    const signupForm = document.getElementById('signup-form');
    if (signupForm) {
        signupForm.addEventListener('submit', (e) => {
            e.preventDefault();
            const name = document.getElementById('signup-name').value;
            const email = document.getElementById('signup-email').value;
            const password = document.getElementById('signup-password').value;
            const errorMessage = document.getElementById('error-message');
            const successMessage = document.getElementById('success-message');

            errorMessage.textContent = '';
            successMessage.textContent = '';

            // 1. Créer l'utilisateur dans Firebase Auth
            auth.createUserWithEmailAndPassword(email, password)
                .then((userCredential) => {
                    const user = userCredential.user;

                    // 2. Créer le document chauffeur dans Firestore
                    return db.collection('chauffeurs').doc(user.uid).set({
                        nom: name,
                        email: email,
                        objectif_journalier: 150, // Valeur par défaut
                        statut: "en_attente",
                        role: "chauffeur"
                    });
                })
                .then(() => {
                    successMessage.textContent = "Inscription réussie ! Votre compte est en attente de validation par un administrateur.";
                    signupForm.reset();
                })
                .catch((error) => {
                    console.error("Erreur d'inscription:", error);
                    errorMessage.textContent = error.message;
                });
        });
    }

    const loginForm = document.getElementById('login-form');
    if (loginForm) {
        loginForm.addEventListener('submit', (e) => {
            e.preventDefault();
            const email = document.getElementById('login-email').value;
            const password = document.getElementById('login-password').value;
            const errorMessage = document.getElementById('error-message');
            errorMessage.textContent = '';

            auth.signInWithEmailAndPassword(email, password)
                .then((userCredential) => {
                    const user = userCredential.user;
                    // Récupérer les infos du chauffeur depuis Firestore
                    return db.collection('chauffeurs').doc(user.uid).get();
                })
                .then((doc) => {
                    if (doc.exists) {
                        const chauffeurData = doc.data();
                        handleRedirect(chauffeurData);
                    } else {
                        // Ne devrait pas arriver si l'inscription crée bien le doc
                        throw new Error("Aucune donnée chauffeur trouvée.");
                    }
                })
                .catch((error) => {
                    console.error("Erreur de connexion:", error);
                    errorMessage.textContent = "Email ou mot de passe incorrect.";
                });
        });
    }

    function handleRedirect(userData) {
        const errorMessage = document.getElementById('error-message');

        if (userData.role === 'admin') {
            window.location.href = 'dashboard-admin.html';
        } else if (userData.role === 'chauffeur') {
            switch (userData.statut) {
                case 'approuve':
                    window.location.href = 'dashboard-chauffeur.html';
                    break;
                case 'en_attente':
                    if(errorMessage) errorMessage.textContent = "Votre compte est en attente de validation.";
                    auth.signOut(); // Déconnecter l'utilisateur pour qu'il ne reste pas bloqué
                    break;
                case 'refuse':
                    if(errorMessage) errorMessage.textContent = "Votre inscription a été refusée.";
                    auth.signOut();
                    break;
                default:
                    if(errorMessage) errorMessage.textContent = "Statut de compte inconnu.";
                    auth.signOut();
            }
        }
    }

    // Gestion de la déconnexion
    const logoutButton = document.getElementById('logout-btn');
    if (logoutButton) {
        logoutButton.addEventListener('click', () => {
            auth.signOut().then(() => {
                window.location.href = 'index.html';
            }).catch((error) => {
                console.error("Erreur de déconnexion:", error);
            });
        });
    }
});