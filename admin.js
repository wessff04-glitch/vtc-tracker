document.addEventListener('DOMContentLoaded', () => {
    if (typeof firebase === 'undefined') {
        alert("Erreur critique: Le SDK Firebase n'est pas chargé.");
        return;
    }

    const auth = firebase.auth();
    const db = firebase.firestore();

    const pendingListContainer = document.getElementById('pending-list-container');
    const approvedListContainer = document.getElementById('approved-list-container');

    let unsubscribe; // Pour se désabonner de l'écouteur onSnapshot lors de la déconnexion

    auth.onAuthStateChanged(async user => {
        if (user) {
            // Vérifier si l'utilisateur est un admin
            const userDoc = await db.collection('chauffeurs').doc(user.uid).get();
            if (userDoc.exists && userDoc.data().role === 'admin') {
                // L'utilisateur est un admin, on charge les données
                loadAndRenderDrivers();
                // show backfill button for admins
                try{
                    const backfillBtn = document.getElementById('backfill-btn');
                    const backfillStatus = document.getElementById('backfill-status');
                    if(backfillBtn){
                        backfillBtn.style.display = 'inline-block';
                        backfillBtn.addEventListener('click', async () => {
                            if(!confirm('Lancer le backfill des timestamps pour toutes les courses ? Cette opération mettra à jour les documents existants. Continuer ?')) return;
                            backfillBtn.disabled = true;
                            backfillStatus.style.display = 'block';
                            backfillStatus.textContent = 'Démarrage du backfill...\n';
                            try{
                                const res = await runBackfill(db, (msg)=>{ backfillStatus.textContent += msg + '\n'; backfillStatus.scrollTop = backfillStatus.scrollHeight; });
                                backfillStatus.textContent += `Backfill terminé. Mis à jour: ${res.updated} / ${res.total}`;
                            }catch(e){
                                console.error('Backfill failed', e);
                                backfillStatus.textContent += 'Erreur durant le backfill: ' + (e && e.message ? e.message : e) + '\n';
                            } finally {
                                backfillBtn.disabled = false;
                            }
                        });
                    }
                }catch(e){ console.warn('backfill UI init failed', e); }
            } else {
                // Pas un admin, on le redirige
                console.warn("Accès non autorisé: l'utilisateur n'est pas un administrateur.");
                window.location.href = 'index.html';
            }
        } else {
            // Pas d'utilisateur connecté
            console.log("Aucun utilisateur connecté, redirection.");
            if (unsubscribe) unsubscribe(); // Nettoyer l'écouteur
            window.location.href = 'index.html';
        }
    });

    function loadAndRenderDrivers() {
        const driversRef = db.collection('chauffeurs');
        
        // onSnapshot écoute les changements en temps réel
        unsubscribe = driversRef.onSnapshot(snapshot => {
            const pendingDrivers = [];
            const approvedDrivers = [];

            snapshot.forEach(doc => {
                const driver = { id: doc.id, ...doc.data() };
                if (driver.role === 'chauffeur') { // S'assurer de ne pas lister l'admin lui-même
                    if (driver.statut === 'en_attente') {
                        pendingDrivers.push(driver);
                    } else if (driver.statut === 'approuve') {
                        approvedDrivers.push(driver);
                    }
                }
            });

            renderDrivers(pendingListContainer, pendingDrivers, 'pending');
            renderDrivers(approvedListContainer, approvedDrivers, 'approved');

        }, error => {
            console.error("Erreur lors de la récupération des chauffeurs:", error);
            pendingListContainer.innerHTML = "<p>Erreur de chargement des données.</p>";
            approvedListContainer.innerHTML = "<p>Erreur de chargement des données.</p>";
        });
    }

    function renderDrivers(container, drivers, type) {
        container.innerHTML = ''; // Vider le conteneur

        if (drivers.length === 0) {
            container.innerHTML = `<p>Aucun chauffeur à afficher.</p>`;
            return;
        }

        const list = document.createElement('ul');
        list.className = 'driver-list';

        drivers.forEach(driver => {
            const item = document.createElement('li');
            item.className = 'driver-item';
            item.dataset.id = driver.id;

            let actionsHtml = '';
            if (type === 'pending') {
                actionsHtml = `
                    <div class="actions">
                        <button class="btn-approve" data-action="approve">Approuver</button>
                        <button class="btn-refuse" data-action="refuse">Refuser</button>
                    </div>`;
            } else if (type === 'approved') {
                actionsHtml = `
                    <div class="update-goal">
                        <label for="goal-${driver.id}">Objectif (€):</label>
                        <input type="number" id="goal-${driver.id}" value="${driver.objectif_journalier || 150}" min="0">
                        <button data-action="save-goal">Enregistrer</button>
                    </div>`;
            }

            item.innerHTML = `
                <strong>${driver.nom}</strong>
                <span class="info">${driver.email}</span>
                ${actionsHtml}
            `;
            list.appendChild(item);
        });

        container.appendChild(list);
    }
    
    // --- Gestion d'événements par délégation ---

    document.body.addEventListener('click', async (e) => {
        const target = e.target;
        const action = target.dataset.action;
        if (!action) return;

        const driverItem = target.closest('.driver-item');
        if (!driverItem) return;
        
        const driverId = driverItem.dataset.id;
        const driverRef = db.collection('chauffeurs').doc(driverId);

        try {
            if (action === 'approve') {
                await driverRef.update({ statut: 'approuve' });
                // onSnapshot s'occupe de la mise à jour de l'UI
            } 
            else if (action === 'refuse') {
                await driverRef.update({ statut: 'refuse' });
                 // onSnapshot s'occupe de la mise à jour de l'UI
            }
            else if (action === 'save-goal') {
                const goalInput = driverItem.querySelector(`input[id="goal-${driverId}"]`);
                if (goalInput) {
                    const newGoal = parseFloat(goalInput.value);
                    if (!isNaN(newGoal) && newGoal >= 0) {
                        await driverRef.update({ objectif_journalier: newGoal });
                        // onSnapshot s'occupe de la mise à jour de l'UI
                        target.textContent = "Enregistré!";
                        setTimeout(() => { target.textContent = "Enregistrer"; }, 2000);
                    } else {
                        alert("Veuillez entrer un objectif valide (nombre positif).");
                    }
                }
            }
        } catch (error) {
            console.error(`Erreur lors de l'action "${action}" sur le chauffeur ${driverId}:`, error);
            alert("Une erreur est survenue. Veuillez réessayer.");
        }
    });

    // Backfill helper: updates missing timestamp_depart / timestamp_arrivee
    async function runBackfill(db, onLog){
        const snapshot = await db.collection('courses').get();
        const total = snapshot.size;
        let updated = 0;
        onLog && onLog(`Courses total: ${total}`);
        for(const doc of snapshot.docs){
            const data = doc.data();
            if(data.timestamp_depart) continue;
            let baseDate = null;
            try{
                // doc.createTime may not be available in client SDK; fallback to updateTime or now
                baseDate = (doc.createTime && typeof doc.createTime.toDate === 'function') ? doc.createTime.toDate() : ((doc.updateTime && typeof doc.updateTime.toDate === 'function') ? doc.updateTime.toDate() : new Date());
            }catch(e){ baseDate = new Date(); }
            let heureStr = data.heure_depart_course;
            let dateDepart = new Date(baseDate);
            if(heureStr && typeof heureStr === 'string'){
                if(/\d{4}-\d{2}-\d{2}T/.test(heureStr)){
                    try{ dateDepart = new Date(heureStr); }catch(e){}
                } else if(/^\d{2}:\d{2}/.test(heureStr)){
                    const p = heureStr.split(':'); dateDepart.setHours(parseInt(p[0],10)); dateDepart.setMinutes(parseInt(p[1],10)); dateDepart.setSeconds(0); dateDepart.setMilliseconds(0);
                }
            }
            let dateArrivee = null;
            if(data.heure_arrivee_course && typeof data.heure_arrivee_course === 'string'){
                if(/\d{4}-\d{2}-\d{2}T/.test(data.heure_arrivee_course)){
                    try{ dateArrivee = new Date(data.heure_arrivee_course);}catch(e){}
                } else if(/^\d{2}:\d{2}/.test(data.heure_arrivee_course)){
                    const p = data.heure_arrivee_course.split(':'); dateArrivee = new Date(dateDepart); dateArrivee.setHours(parseInt(p[0],10)); dateArrivee.setMinutes(parseInt(p[1],10));
                }
            }
            const updates = {};
            try{ updates.timestamp_depart = firebase.firestore.Timestamp.fromDate(dateDepart); }catch(e){}
            if(dateArrivee) try{ updates.timestamp_arrivee = firebase.firestore.Timestamp.fromDate(dateArrivee); }catch(e){}
            if(Object.keys(updates).length){
                try{ await doc.ref.update(updates); updated++; onLog && onLog(`Updated ${doc.id}`); }catch(e){ onLog && onLog(`Failed ${doc.id}: ${e.message || e}`); }
            }
        }
        return { total, updated };
    }
});
