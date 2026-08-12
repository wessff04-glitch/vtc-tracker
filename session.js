document.addEventListener('DOMContentLoaded', () => {
    // Assurez-vous que les SDK Firebase sont chargés
    if (typeof firebase === 'undefined') {
        console.error("Firebase SDK not loaded. Make sure to include the scripts in your HTML.");
        alert("Erreur critique: Le SDK Firebase n'est pas chargé.");
        return;
    }

    const auth = firebase.auth();
    const db = firebase.firestore();

    const sessionStatusEl = document.getElementById('session-status');
    const startDayBtn = document.getElementById('start-day-btn');
    const endDayBtn = document.getElementById('end-day-btn');

    let currentUserId = null;
    let activeSessionId = null;

    // Observer les changements d'état de l'authentification
    auth.onAuthStateChanged(user => {
        if (user) {
            // L'utilisateur est connecté
            currentUserId = user.uid;
            checkActiveSession(currentUserId);
        } else {
            // L'utilisateur n'est pas connecté, on le redirige
            console.log("Aucun utilisateur connecté, redirection vers la page de connexion.");
            window.location.href = 'index.html';
        }
    });

    // Vérifie s'il y a une session de travail active pour le chauffeur
    async function checkActiveSession(userId) {
        if (!sessionStatusEl) return;
        sessionStatusEl.textContent = 'Vérification de la session...';
        
        try {
            const sessionsRef = db.collection('sessions');
            const query = sessionsRef
                .where('chauffeur_id', '==', userId)
                .where('heure_fin', '==', null)
                .limit(1);

            const snapshot = await query.get();

            if (snapshot.empty) {
                // Aucune session active trouvée
                updateUIForNoSession();
            } else {
                // Une session active existe
                const sessionDoc = snapshot.docs[0];
                activeSessionId = sessionDoc.id;
                updateUIForActiveSession(sessionDoc.data());
            }
        } catch (error) {
            console.error("Erreur lors de la vérification de la session:", error);
            sessionStatusEl.textContent = "Erreur de chargement.";
        }
    }

    // Met à jour l'interface pour un état "session en cours"
    function updateUIForActiveSession(sessionData) {
        sessionStatusEl.textContent = `Journée en cours depuis ${sessionData.heure_debut}`;
        startDayBtn.style.display = 'none';
        endDayBtn.style.display = 'block';
    }

    // Met à jour l'interface pour un état "aucune session"
    function updateUIForNoSession() {
        sessionStatusEl.textContent = 'Aucune session en cours';
        startDayBtn.style.display = 'block';
        endDayBtn.style.display = 'none';
        activeSessionId = null;
    }
    
    // --- Gestionnaires d'événements ---

    // Clic sur "Démarrer ma journée"
    startDayBtn.addEventListener('click', async () => {
        startDayBtn.disabled = true;
        startDayBtn.textContent = 'Démarrage...';

        try {
            // Double vérification pour éviter les sessions en double (race condition)
            const sessionsRef = db.collection('sessions');
            const query = sessionsRef
                .where('chauffeur_id', '==', currentUserId)
                .where('heure_fin', '==', null)
                .limit(1);
            const snapshot = await query.get();

            if (!snapshot.empty) {
                console.log("Une session active a été trouvée juste avant la création.");
                checkActiveSession(currentUserId); // Met à jour l'UI et termine
                return;
            }

            // Récupérer l'objectif journalier du chauffeur
            const chauffeurDocRef = db.collection('chauffeurs').doc(currentUserId);
            const chauffeurDoc = await chauffeurDocRef.get();
            
            if (!chauffeurDoc.exists) {
                throw new Error("Document du chauffeur introuvable.");
            }
            const objectifDuJour = chauffeurDoc.data().objectif_journalier || 0;

            // Créer le nouveau document de session
            const now = new Date();
            const newSession = {
                chauffeur_id: currentUserId,
                date: now.toISOString().split('T')[0], // Format YYYY-MM-DD
                heure_debut: now.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }), // Format HH:MM
                heure_fin: null,
                objectif_du_jour: objectifDuJour
            };

            await db.collection('sessions').add(newSession);
            
            // Mettre à jour l'interface
            await checkActiveSession(currentUserId);

        } catch (error) {
            console.error("Erreur lors du démarrage de la journée:", error);
            alert("Impossible de démarrer la journée. Veuillez réessayer.");
        } finally {
            startDayBtn.disabled = false;
            startDayBtn.textContent = 'Démarrer ma journée';
        }
    });

    // Clic sur "Terminer ma journée"
    endDayBtn.addEventListener('click', async () => {
        if (!activeSessionId) {
            alert("Aucune session active à terminer.");
            checkActiveSession(currentUserId); // Resynchroniser l'UI
            return;
        }

        endDayBtn.disabled = true;
        endDayBtn.textContent = 'Arrêt en cours...';

        try {
            const sessionDocRef = db.collection('sessions').doc(activeSessionId);
            const now = new Date();
            const heureFin = now.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });

            await sessionDocRef.update({
                heure_fin: heureFin
            });
            
            // Mettre à jour l'interface
            await checkActiveSession(currentUserId);

        } catch (error) {
            console.error("Erreur lors de la fin de la journée:", error);
            alert("Impossible de terminer la journée. Veuillez réessayer.");
        } finally {
            endDayBtn.disabled = false;
            endDayBtn.textContent = 'Terminer ma journée';
        }
    });
});
