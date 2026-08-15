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
            try{
                const userDoc = await db.collection('chauffeurs').doc(user.uid).get();
                if (userDoc.exists && userDoc.data().role === 'admin') {
                    // L'utilisateur est un admin, on charge les données
                    loadAndRenderDrivers();
                } else {
                    // Pas un admin, on le redirige
                    console.warn("Accès non autorisé: l'utilisateur n'est pas un administrateur.");
                    alert('Accès réservé aux administrateurs.');
                    window.location.href = 'index.html';
                }
            }catch(err){
                console.error('Erreur lors de la récupération du document utilisateur (permissions?)', err);
                alert('Impossible de vérifier les permissions. Vérifiez les règles Firestore et que votre compte a les droits admin.');
                if (unsubscribe) unsubscribe();
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

            // add view courses button for approved drivers
            if(type === 'approved'){
                actionsHtml += ` <button data-action="view-courses" class="btn-view-courses" style="margin-left:8px">Voir courses</button>`;
            }

            item.innerHTML = `
                <strong>${driver.nom}</strong>
                <span class="info">${driver.email}</span>
                ${actionsHtml}
            `;
            list.appendChild(item);
            // add metrics placeholder and fetch metrics for approved drivers
            if(type === 'approved'){
                const metricsEl = document.createElement('div');
                metricsEl.className = 'driver-metrics';
                metricsEl.id = `metrics-${driver.id}`;
                metricsEl.textContent = 'Chargement des métriques...';
                item.appendChild(metricsEl);
                fetchAndRenderDriverMetrics(driver.id, metricsEl);
            }
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
            else if(action === 'view-courses'){
                // open modal with driver's courses
                const driverItem = target.closest('.driver-item');
                if(!driverItem) return;
                const driverId = driverItem.dataset.id;
                openDriverCoursesModal(driverId);
            }
        } catch (error) {
            console.error(`Erreur lors de l'action "${action}" sur le chauffeur ${driverId}:`, error);
            alert("Une erreur est survenue. Veuillez réessayer.");
        }
    });

    // Modal: fetch and display courses for a driver with simple filters
    async function openDriverCoursesModal(driverId){
        const modal = document.createElement('div'); modal.className = 'route-modal';
        modal.innerHTML = `
            <div class="modal-content">
                <div class="modal-header">
                    <h3>Courses du chauffeur</h3>
                    <button class="modal-close">&times;</button>
                </div>
                <div style="padding:12px;display:flex;gap:8px;align-items:center">
                    <label>Filtre:</label>
                    <select id="admin-course-filter">
                        <option value="today">Aujourd'hui</option>
                        <option value="7">7 jours</option>
                        <option value="30">30 jours</option>
                        <option value="all">Tous</option>
                    </select>
                    <button id="admin-refresh-courses" class="btn">Rafraîchir</button>
                </div>
                <div id="admin-courses-list" style="padding:12px;max-height:60vh;overflow:auto"></div>
            </div>
        `;
        document.body.appendChild(modal);
        modal.querySelector('.modal-close').addEventListener('click', () => modal.remove());
        const listEl = modal.querySelector('#admin-courses-list');
        const refreshBtn = modal.querySelector('#admin-refresh-courses');
        const filterEl = modal.querySelector('#admin-course-filter');

        async function loadCoursesForDriver(){
            listEl.innerHTML = 'Chargement...';
            try{
                const f = filterEl.value;
                let query = db.collection('courses').where('chauffeur_id','==', driverId).orderBy('timestamp_depart','desc');
                if(f === 'today'){
                    const now = new Date(); const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
                    query = db.collection('courses').where('chauffeur_id','==', driverId).where('timestamp_depart','>=', firebase.firestore.Timestamp.fromDate(start)).orderBy('timestamp_depart','desc');
                } else if(f === '7' || f === '30'){
                    const days = parseInt(f,10);
                    const since = new Date(); since.setDate(since.getDate() - days);
                    query = db.collection('courses').where('chauffeur_id','==', driverId).where('timestamp_depart','>=', firebase.firestore.Timestamp.fromDate(since)).orderBy('timestamp_depart','desc');
                } else {
                    query = db.collection('courses').where('chauffeur_id','==', driverId).orderBy('timestamp_depart','desc').limit(500);
                }

                // Try snapshot; if index error, fallback to GET without timestamp filter
                try{
                    const snap = await query.get();
                    if(snap.empty){ listEl.innerHTML = '<p>Aucune course trouvée.</p>'; return; }
                    renderAdminCourses(snap.docs, listEl);
                }catch(err){
                    console.warn('admin driver courses query failed, fallback GET', err);
                    const snap2 = await db.collection('courses').where('chauffeur_id','==', driverId).limit(500).get();
                    if(snap2.empty){ listEl.innerHTML = '<p>Aucune course trouvée.</p>'; return; }
                    renderAdminCourses(snap2.docs, listEl);
                }
            }catch(e){ console.error('Failed loading driver courses', e); listEl.innerHTML = '<p>Erreur de chargement.</p>'; }
        }

        refreshBtn.addEventListener('click', loadCoursesForDriver);
        loadCoursesForDriver();
    }

    function renderAdminCourses(docs, container){
        container.innerHTML = '';
        docs.forEach(doc => {
            const c = doc.data();
            const row = document.createElement('div');
            row.style.padding = '8px'; row.style.borderBottom = '1px solid #eee';
            const time = c.timestamp_depart && c.timestamp_depart.toDate ? c.timestamp_depart.toDate().toISOString() : (c.heure_depart_course || '—');
            row.innerHTML = `<div style="display:flex;justify-content:space-between;align-items:center"><div><strong>${time}</strong><div class="muted">${(c.distance||0).toFixed(1)} km • ${c.duree||0} min</div></div><div style="font-weight:700">€${(c.prix||0).toFixed(2)}</div></div>`;
            container.appendChild(row);
        });
    }

    // Backfill helper: updates missing timestamp_depart / timestamp_arrivee
    // fetch metrics for a driver (last 30 days)
    async function fetchAndRenderDriverMetrics(driverId, containerEl){
        try{
            const since = new Date(); since.setDate(since.getDate() - 30);
            const snap = await db.collection('courses').where('chauffeur_id','==', driverId).where('timestamp_depart','>=', firebase.firestore.Timestamp.fromDate(since)).get();
            let totalEarned = 0, totalDistance = 0, totalDuration = 0, count = 0;
            snap.forEach(d => { const c = d.data(); totalEarned += (c.prix||0); totalDistance += (c.distance||0); totalDuration += (c.duree||0); count++; });
            containerEl.innerHTML = `<div style="display:flex;gap:12px;flex-wrap:wrap">
                <div><strong>${Math.round(totalEarned)} €</strong><div class="muted">30j revenu</div></div>
                <div><strong>${(Math.round(totalDistance*10)/10).toFixed(1)} km</strong><div class="muted">30j distance</div></div>
                <div><strong>${count}</strong><div class="muted">30j courses</div></div>
            </div>`;
        }catch(e){ console.error('fetchAndRenderDriverMetrics failed', e); containerEl.textContent = 'Erreur chargement métriques'; }
    }
});
