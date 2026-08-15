// js/stats.js
let statsChart = null;
let coursesUnsub = null;
let statsUnsub = null;
let db = null;
let dailyStatsUnsub = null;
let dailyTimerId = null;
let periodicRefreshId = null;

// Helper functions used by tab handlers (were missing and caused ReferenceError)
function loadCourses(filter){
    attachCoursesListener(filter || 'today');
}

function loadStatsData(period){
    attachStatsListener(period || 'day');
}

function setupTabs(){
    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            // detach previous listeners to avoid duplicates
            detachCoursesListener();
            detachStatsListener();
            if(dailyStatsUnsub){ dailyStatsUnsub(); dailyStatsUnsub = null; }
            if(dailyTimerId){ clearInterval(dailyTimerId); dailyTimerId = null; }

            const tabName = btn.dataset.tab;
            document.querySelectorAll('.tab-content').forEach(tab => tab.classList.add('hidden'));
            const sel = document.getElementById(tabName);
            if(sel) sel.classList.remove('hidden');
            document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');

            // attach relevant listener for the tab
            if(tabName === 'tab-stats') loadStatsData('day');
            if(tabName === 'tab-courses') loadCourses(document.getElementById('courses-filter')?.value || 'today');
            if(tabName === 'tab-journee') {
                const uid = firebase.auth().currentUser && firebase.auth().currentUser.uid;
                const period = document.querySelector('.daily-period-btn.active')?.dataset.period || 'day';
                if(uid) ecouterStats(uid, period);
            }
        });
    });
}

function detachDailyStats(){
    if(dailyStatsUnsub){ dailyStatsUnsub(); dailyStatsUnsub = null; }
    if(dailyTimerId){ clearInterval(dailyTimerId); dailyTimerId = null; }
}

// Utility: get prioritized objective for a user and compute objective for given period
async function getObjectiveForUser(uid, period = 'day'){
    let objectifJournalier = 0;
    try{
        // 1) prefer session override when session active
        const sSnap = await db.collection('sessions').where('chauffeur_id','==',uid).where('heure_fin','==',null).limit(1).get();
        if(!sSnap.empty){
            const s = sSnap.docs[0].data();
            if(typeof s.objectif_du_jour !== 'undefined'){
                objectifJournalier = s.objectif_du_jour;
            }
        }
    }catch(e){ console.warn('getObjectiveForUser session read failed', e); }

    try{
        if(typeof objectifJournalier === 'undefined' || objectifJournalier === 0){
            const ch = await db.collection('chauffeurs').doc(uid).get();
            if(ch.exists && typeof ch.data().objectif_journalier !== 'undefined'){
                objectifJournalier = ch.data().objectif_journalier || 0;
            }
        }
    }catch(e){ console.warn('getObjectiveForUser chauffeur read failed', e); }

    // days factor (calendar-based)
    const now = new Date();
    let daysFactor = 1;
    if(period === 'day') daysFactor = 1;
    else if(period === 'week') daysFactor = 7;
    else if(period === 'month') daysFactor = new Date(now.getFullYear(), now.getMonth()+1, 0).getDate();
    const objectifForPeriod = Math.round(objectifJournalier * daysFactor);
    return { objectifJournalier, objectifForPeriod, daysFactor };
}

function detachCoursesListener(){
    if(coursesUnsub){ coursesUnsub(); coursesUnsub = null; }
}

function ecouterStats(uid, period = 'day'){
    console.debug('ecouterStats called', { uid, period });
    // detach previous
    if(dailyStatsUnsub){ dailyStatsUnsub(); dailyStatsUnsub = null; }
    if(dailyTimerId){ clearInterval(dailyTimerId); dailyTimerId = null; }
    if(!uid) return;
    const now = new Date();
    let startDate = new Date();
    if(period === 'day') startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    else if(period === 'week') startDate = new Date(now.getTime() - 7*24*60*60*1000);
    else if(period === 'month') startDate = new Date(now.getFullYear(), now.getMonth(), 1);

    const startTimestamp = firebase.firestore.Timestamp.fromDate(startDate);
    const query = db.collection('courses').where('chauffeur_id','==',uid).where('timestamp_depart','>=', startTimestamp);
    dailyStatsUnsub = query.onSnapshot(async snapshot => {
        console.debug('ecouterStats snapshot received', { size: snapshot.size });
        // compute totals
        let totalEarned = 0; let totalDistance = 0; let totalDuree = 0; let coursesCount = 0;
        snapshot.forEach(doc => { const c = doc.data(); totalEarned += (c.prix||0); totalDistance += (c.distance||0); totalDuree += (c.duree||0); coursesCount++; });

        // If snapshot empty, try fallback to recent docs (some older docs may not have timestamp_depart)
        if(snapshot.empty){
            try{
                console.warn('ecouterStats: snapshot empty, trying fallback GET for recent courses');
                const fallbackSnap = await db.collection('courses').where('chauffeur_id','==',uid).limit(50).get();
                if(!fallbackSnap.empty){
                    totalEarned = 0; totalDistance = 0; totalDuree = 0; coursesCount = 0;
                    fallbackSnap.forEach(doc => { const c = doc.data(); totalEarned += (c.prix||0); totalDistance += (c.distance||0); totalDuree += (c.duree||0); coursesCount++; });
                }
            }catch(fbErr){ console.error('Fallback ecouterStats failed', fbErr); }
        }

        // update UI
        try{ document.getElementById('daily-earned').textContent = `${Math.round(totalEarned)} €`; }catch(e){}
        try{ document.getElementById('daily-distance').textContent = `${(Math.round(totalDistance*10)/10).toFixed(1)} km`; }catch(e){}
        try{ document.getElementById('daily-courses-count').textContent = coursesCount; }catch(e){}

        // time worked and per-hour
        let workMinutes = totalDuree; // default from sum of course durations

        if(period === 'day'){
            // prefer live session duration if session active
            try{
                const sessionSnap = await db.collection('sessions').where('chauffeur_id','==',uid).where('heure_fin','==',null).limit(1).get();
                if(!sessionSnap.empty){
                    const s = sessionSnap.docs[0].data();
                    // show live badge
                    try{ document.getElementById('daily-live-badge').style.display = 'inline-block'; }catch(e){}
                    // build session start datetime from session.date (YYYY-MM-DD) and heure_debut (HH:MM)
                    let startDt = null;
                    if(s.date && s.heure_debut){
                        const iso = `${s.date}T${s.heure_debut}:00`;
                        startDt = new Date(iso);
                    }
                    if(startDt && !isNaN(startDt.getTime())){
                        const updateLive = () => {
                            const now2 = new Date();
                            const diffMs = now2 - startDt;
                            const hh = Math.floor(diffMs / (1000*60*60));
                            const mm = Math.floor((diffMs % (1000*60*60)) / (1000*60));
                            try{ document.getElementById('daily-worktime').textContent = `${hh}h ${String(mm).padStart(2,'0')}`; }catch(e){}
                            // per hour using live elapsed
                            const minutesElapsed = Math.max(1, Math.floor(diffMs/60000));
                            const perHourLive = (totalEarned / minutesElapsed) * 60;
                            try{
                                if(minutesElapsed < 60){
                                    document.getElementById('daily-per-hour').textContent = `${Math.round(totalEarned)} €`;
                                } else {
                                    document.getElementById('daily-per-hour').textContent = `${Math.round(perHourLive)} €/h`;
                                }
                            }catch(e){}
                        };
                        updateLive();
                        dailyTimerId = setInterval(updateLive, 1000);
                    } else {
                        try{ document.getElementById('daily-live-badge').style.display = 'none'; }catch(e){}
                        // fallback to sum of durations
                        const hh = Math.floor(workMinutes/60); const mm = workMinutes%60;
                        try{ document.getElementById('daily-worktime').textContent = `${hh}h ${String(mm).padStart(2,'0')}`; }catch(e){}
                        const perHour = workMinutes ? (totalEarned / workMinutes) * 60 : 0;
                        try{
                            if(workMinutes < 60){
                                document.getElementById('daily-per-hour').textContent = `${Math.round(totalEarned)} €`;
                            } else {
                                document.getElementById('daily-per-hour').textContent = `${Math.round(perHour)} €/h`;
                            }
                        }catch(e){}
                    }
                } else {
                    try{ document.getElementById('daily-live-badge').style.display = 'none'; }catch(e){}
                    const hh = Math.floor(workMinutes/60); const mm = workMinutes%60;
                    try{ document.getElementById('daily-worktime').textContent = `${hh}h ${String(mm).padStart(2,'0')}`; }catch(e){}
                    const perHour = workMinutes ? (totalEarned / workMinutes) * 60 : 0;
                    try{ document.getElementById('daily-per-hour').textContent = `${Math.round(perHour)} €/h`; }catch(e){}
                }
            }catch(e){ console.warn('ecouterStats session check failed', e); }
        } else {
            // week/month: show total duration sum
            const hh = Math.floor(workMinutes/60); const mm = workMinutes%60;
            try{ document.getElementById('daily-worktime').textContent = `${hh}h ${String(mm).padStart(2,'0')}`; }catch(e){}
            const perHour = workMinutes ? (totalEarned / workMinutes) * 60 : 0;
            try{
                if(workMinutes < 60){
                    document.getElementById('daily-per-hour').textContent = `${Math.round(totalEarned)} €`;
                } else {
                    document.getElementById('daily-per-hour').textContent = `${Math.round(perHour)} €/h`;
                }
            }catch(e){}
        }

        // objective (use centralized helper)
        try{
            const obj = await getObjectiveForUser(uid, period);
            const objectifForPeriod = obj.objectifForPeriod || 0;
            const percent = objectifForPeriod ? Math.min((totalEarned / objectifForPeriod) * 100, 100) : 0;
            try{ document.getElementById('daily-progress-bar').style.width = percent + '%'; }catch(e){}
            try{ document.getElementById('daily-progress-text').textContent = `${Math.round(totalEarned)} € / ${objectifForPeriod} €`; }catch(e){}
        }catch(e){ console.warn('ecouterStats objectif fetch failed', e); }
    }, async err => {
        console.error('Daily stats snapshot error', err);
        try{
            const msg = (err && (err.message || '')).toLowerCase();
            if(msg.includes('requires an index') || msg.includes('index')){
                console.warn('Daily stats: index error — using fallback GET for recent courses');
                const fallbackSnap = await db.collection('courses').where('chauffeur_id','==',uid).limit(200).get();
                let totalEarned = 0; let totalDistance = 0; let totalDuree = 0; let coursesCount = 0;
                fallbackSnap.forEach(doc => {
                    const c = doc.data();
                    // try to include only docs in period when possible
                    let include = true;
                    try{
                        if(c.timestamp_depart && c.timestamp_depart.toDate){
                            include = c.timestamp_depart.toDate() >= startDate;
                        } else if(c.heure_depart_course){
                            const d = new Date(c.heure_depart_course);
                            if(!isNaN(d.getTime())) include = d >= startDate;
                        }
                    }catch(e){}
                    if(include){ totalEarned += (c.prix||0); totalDistance += (c.distance||0); totalDuree += (c.duree||0); coursesCount++; }
                });

                try{ document.getElementById('daily-earned').textContent = `${Math.round(totalEarned)} €`; }catch(e){}
                try{ document.getElementById('daily-distance').textContent = `${(Math.round(totalDistance*10)/10).toFixed(1)} km`; }catch(e){}
                try{ document.getElementById('daily-courses-count').textContent = coursesCount; }catch(e){}
                const hh = Math.floor(totalDuree/60); const mm = totalDuree%60;
                try{ document.getElementById('daily-worktime').textContent = `${hh}h ${String(mm).padStart(2,'0')}`; }catch(e){}
                const perHour = totalDuree ? (totalEarned / totalDuree) * 60 : 0;
                try{ document.getElementById('daily-per-hour').textContent = `${Math.round(perHour)} €/h`; }catch(e){}
                // update progress / objective using chauffeur doc if possible
                try{
                    const obj = await getObjectiveForUser(uid, period);
                    const objectifForPeriod = obj.objectifForPeriod || 0;
                    const percent = objectifForPeriod ? Math.min((totalEarned / objectifForPeriod) * 100, 100) : 0;
                    try{ document.getElementById('daily-progress-bar').style.width = percent + '%'; }catch(e){}
                    try{ document.getElementById('daily-progress-text').textContent = `${Math.round(totalEarned)} € / ${objectifForPeriod} €`; }catch(e){}
                }catch(eObj){ console.warn('Failed to update daily objective in fallback', eObj); }
            }
        }catch(fbErr){ console.error('Daily stats fallback failed', fbErr); }
    });
}

function attachCoursesListener(filter = 'today'){
    detachCoursesListener();
    const user = firebase.auth().currentUser;
    if(!user) return;
    console.log('attachCoursesListener', { filter, uid: user.uid });
    let query = db.collection('courses').where('chauffeur_id','==',user.uid).orderBy('timestamp_depart','desc');
    const now = new Date();
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const startOfWeek = new Date(now.getTime() - 7*24*60*60*1000);
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    if(filter === 'today') query = query.where('timestamp_depart','>=', firebase.firestore.Timestamp.fromDate(startOfDay));
    else if(filter === 'week') query = query.where('timestamp_depart','>=', firebase.firestore.Timestamp.fromDate(startOfWeek));
    else if(filter === 'month') query = query.where('timestamp_depart','>=', firebase.firestore.Timestamp.fromDate(startOfMonth));

    coursesUnsub = query.onSnapshot(snapshot => {
        console.log('courses snapshot', { size: snapshot.size, ids: snapshot.docs.map(d=>d.id).slice(0,10) });
        const coursesList = document.getElementById('courses-list');
        if(!coursesList) return;
        coursesList.innerHTML = '';
        // update my rides button count if present
        try{ const myRidesBtn = document.getElementById('my-rides-btn'); if(myRidesBtn) myRidesBtn.textContent = `Mes courses (${snapshot.size})`; }catch(e){}
        if(snapshot.empty){
            // Fallback: some older documents may lack `timestamp_depart` — fetch recent courses without timestamp filter
            console.warn('No courses found with timestamp filter, using fallback query to show recent courses.');
            db.collection('courses').where('chauffeur_id','==',user.uid).limit(50).get().then(fallbackSnap => {
                if(fallbackSnap.empty){
                    coursesList.innerHTML = '<p>Aucune course trouvée.</p>';
                    return;
                }
                fallbackSnap.forEach(doc => renderCourseCard(doc, coursesList));
                try{ const myRidesBtn = document.getElementById('my-rides-btn'); if(myRidesBtn) myRidesBtn.textContent = `Mes courses (${fallbackSnap.size})`; }catch(e){}
                // show hint to admin
                const hint = document.createElement('div'); hint.className='muted'; hint.style.marginTop='8px'; hint.textContent = 'Remarque: certaines courses anciennes n\'ont pas de timestamps Firestore. Exécutez le backfill depuis l\'espace admin pour restaurer le filtrage par période.';
                coursesList.appendChild(hint);
                document.querySelectorAll('.view-route-btn').forEach(b => { b.addEventListener('click', (e) => showCourseMap(e.target.dataset.id)); });
            }).catch(err => { console.error('Fallback query failed', err); coursesList.innerHTML = '<p>Erreur lors du chargement des courses.</p>'; });
            return;
        }

        snapshot.forEach(doc => {
            const course = doc.data();
            const courseCard = document.createElement('div');
            courseCard.className = 'course-card';
            const avg = course.distance && course.distance > 0 ? (course.prix / course.distance).toFixed(2) : '—';
            courseCard.innerHTML = `
                <div class="course-card-header">
                    <span class="course-time">${course.heure_depart_course} → ${course.heure_arrivee_course}</span>
                    <span class="course-price">€${course.prix.toFixed(2)}</span>
                </div>
                <div class="course-card-stats">
                    <div class="course-card-stat">
                        <span class="course-card-stat-label">Distance</span>
                        <span class="course-card-stat-value">${course.distance.toFixed(1)} km</span>
                    </div>
                    <div class="course-card-stat">
                        <span class="course-card-stat-label">Durée</span>
                        <span class="course-card-stat-value">${course.duree} min</span>
                    </div>
                    <div class="course-card-stat">
                        <span class="course-card-stat-label">Moyenne</span>
                        <span class="course-card-stat-value">€${avg}/km</span>
                    </div>
                </div>
                <div class="course-card-action">
                    <button class="view-route-btn" data-id="${doc.id}">📍 Voir le trajet</button>
                </div>
            `;
            coursesList.appendChild(courseCard);
        });
        // wire view buttons
        document.querySelectorAll('.view-route-btn').forEach(b => { b.addEventListener('click', (e) => showCourseMap(e.target.dataset.id)); });
    }, async err => {
        console.error('Courses snapshot error', err);
        // If the error is due to a missing/building index, perform a fallback GET
        try{
            const msg = (err && (err.message || '')).toLowerCase();
            const coursesList = document.getElementById('courses-list');
            if(coursesList && (msg.includes('requires an index') || msg.includes('index'))){
                console.warn('Index missing/building — using fallback query to display recent courses.');
                coursesList.innerHTML = '';
                const fallbackSnap = await db.collection('courses').where('chauffeur_id','==',user.uid).limit(50).get();
                if(fallbackSnap.empty){
                    coursesList.innerHTML = '<p>Aucune course trouvée.</p>';
                } else {
                    fallbackSnap.forEach(doc => renderCourseCard(doc, coursesList));
                    const hint = document.createElement('div'); hint.className='muted'; hint.style.marginTop='8px'; hint.textContent = 'Remarque: index en construction. Affichage en mode secours (récupère les 50 courses récentes).';
                    coursesList.appendChild(hint);
                    document.querySelectorAll('.view-route-btn').forEach(b => { b.addEventListener('click', (e) => showCourseMap(e.target.dataset.id)); });
                }
            }
        }catch(e2){ console.error('Fallback query failed', e2); }
    });
}

function renderCourseCard(doc, container){
    const course = doc.data();
    const courseCard = document.createElement('div');
    courseCard.className = 'course-card';
    const avg = course.distance && course.distance > 0 ? (course.prix / course.distance).toFixed(2) : '—';
    courseCard.innerHTML = `
        <div class="course-card-header">
            <span class="course-time">${course.heure_depart_course || '??:??'} → ${course.heure_arrivee_course || '??:??'}</span>
            <span class="course-price">€${(course.prix||0).toFixed(2)}</span>
        </div>
        <div class="course-card-stats">
            <div class="course-card-stat">
                <span class="course-card-stat-label">Distance</span>
                <span class="course-card-stat-value">${(course.distance||0).toFixed(1)} km</span>
            </div>
            <div class="course-card-stat">
                <span class="course-card-stat-label">Durée</span>
                <span class="course-card-stat-value">${course.duree||0} min</span>
            </div>
            <div class="course-card-stat">
                <span class="course-card-stat-label">Moyenne</span>
                <span class="course-card-stat-value">€${avg}/km</span>
            </div>
        </div>
        <div class="course-card-action">
            <button class="view-route-btn" data-id="${doc.id}">📍 Voir le trajet</button>
        </div>
    `;
    container.appendChild(courseCard);
}

function showMapModal(course){
    const modal = document.createElement('div');
    modal.className = 'route-modal';
    modal.innerHTML = `
        <div class="modal-content">
            <div class="modal-header">
                <h3>Trajet de la course</h3>
                <button class="modal-close">&times;</button>
            </div>
            <div id="route-map-container" style="height:400px;"></div>
            <div class="route-details">
                <div class="detail-row"><span>Distance</span><span>${course.distance.toFixed(1)} km</span></div>
                <div class="detail-row"><span>Durée</span><span>${course.duree} min</span></div>
                <div class="detail-row"><span>Prix</span><span>€${course.prix}</span></div>
            </div>
        </div>
    `;
    document.body.appendChild(modal);

    const map = L.map('route-map-container').setView([course.coords_depart.lat, course.coords_depart.lng], 15);
    L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', { attribution: '© OpenStreetMap contributors © CARTO' }).addTo(map);

    L.circleMarker([course.coords_depart.lat, course.coords_depart.lng], { radius:8, fillColor:'#00A86B', color:'white', weight:2, opacity:1, fillOpacity:0.8 }).addTo(map).bindPopup('Départ');
    L.circleMarker([course.coords_arrivee.lat, course.coords_arrivee.lng], { radius:8, fillColor:'#FF6B6B', color:'white', weight:2, opacity:1, fillOpacity:0.8 }).addTo(map).bindPopup('Arrivée');

    const latlngs = (course.trajet_gps || []).map(p => [p.lat, p.lng]);
    if(latlngs.length) L.polyline(latlngs, { color:'#00A86B', weight:4, opacity:0.8 }).addTo(map);
    if(latlngs.length) map.fitBounds(L.latLngBounds(latlngs), { padding:[50,50] });

    modal.querySelector('.modal-close').addEventListener('click', () => { modal.remove(); try{ map.remove(); }catch(e){} });
}

function showCourseMap(courseId){
    db.collection('courses').doc(courseId).get().then(doc => {
        if(!doc.exists) return alert('Course introuvable');
        showMapModal(doc.data());
    }).catch(err => console.error(err));
}

function detachStatsListener(){ if(statsUnsub){ statsUnsub(); statsUnsub = null; } }

function attachStatsListener(period = 'day'){
    detachStatsListener();
    const user = firebase.auth().currentUser;
    if(!user) return;
    console.log('attachStatsListener', { period, uid: user.uid });
    const now = new Date();
    let startDate = new Date();
    if(period === 'day') startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    else if(period === 'week') startDate = new Date(now.getTime() - 7*24*60*60*1000);
    else if(period === 'month') startDate = new Date(now.getFullYear(), now.getMonth(), 1);
    else if(period === 'year') startDate = new Date(now.getFullYear(), 0, 1);

    const startTimestamp = firebase.firestore.Timestamp.fromDate(startDate);
    const query = db.collection('courses').where('chauffeur_id','==',user.uid).where('timestamp_depart','>=', startTimestamp);
    statsUnsub = query.onSnapshot(snapshot => {
        let totalEarned = 0; let totalDistance = 0; let totalTime = 0; const coursesArray = [];
        snapshot.forEach(doc => { const c = doc.data(); totalEarned += c.prix; totalDistance += c.distance; totalTime += c.duree; coursesArray.push(c); });

        const avgPrice = coursesArray.length ? totalEarned / coursesArray.length : 0;
        const avgDistance = coursesArray.length ? totalDistance / coursesArray.length : 0;
        const perHour = totalTime ? (totalEarned / totalTime) * 60 : 0;
        const perKm = totalDistance ? totalEarned / totalDistance : 0;

        document.getElementById('kpi-earned').textContent = `€${totalEarned.toFixed(2)}`;
        document.getElementById('kpi-courses').textContent = coursesArray.length;
        document.getElementById('kpi-courses-avg').textContent = coursesArray.length ? `${avgPrice.toFixed(2)}€/course` : '—';
        document.getElementById('kpi-distance').textContent = `${totalDistance.toFixed(1)} km`;
        document.getElementById('kpi-distance-avg').textContent = `${avgDistance.toFixed(1)} km/course`;

        const hours = Math.floor(totalTime / 60); const mins = Math.round(totalTime % 60);
        document.getElementById('metadata-time').textContent = `${hours}h ${mins}min`;
        document.getElementById('metadata-avg-price').textContent = `€${avgPrice.toFixed(2)}`;
        document.getElementById('metadata-per-hour').textContent = `€${perHour.toFixed(2)}`;
        document.getElementById('metadata-per-km').textContent = `€${perKm.toFixed(2)}`;

                // progress (centralized objective)
        (async ()=>{
            try{
                const obj = await getObjectiveForUser(user.uid, period);
                const objectifJournalier = obj.objectifJournalier || 0;
                const objectifForPeriod = obj.objectifForPeriod || 0;
                const progressPercent = objectifForPeriod ? (totalEarned / objectifForPeriod) * 100 : 0;
                try{ document.getElementById('progress-bar-fill').style.width = Math.min(progressPercent,100) + '%'; }catch(e){}
                try{ document.getElementById('progress-earned').textContent = `€${totalEarned.toFixed(2)}`; }catch(e){}
                try{ document.getElementById('progress-goal').textContent = `€${objectifForPeriod}`; }catch(e){}
                try{ document.getElementById('kpi-earned-vs-goal').textContent = `${Math.round(progressPercent)}% objectif`; }catch(e){}

                // Also update session progress (always show daily progress)
                try{
                    const sessionFillEl = document.getElementById('session-progress-fill');
                    const sessionTextEl = document.getElementById('session-progress-text');
                    if(sessionFillEl && sessionTextEl){
                        // compute today's earnings
                        const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
                        const todaySnap = await db.collection('courses').where('chauffeur_id','==',user.uid).where('timestamp_depart','>=', firebase.firestore.Timestamp.fromDate(startOfDay)).get();
                        let todayEarned = 0;
                        todaySnap.forEach(d => { const c = d.data(); todayEarned += (c.prix||0); });
                        const dailyObjective = objectifJournalier || 0;
                        const dailyPercent = dailyObjective ? (todayEarned / dailyObjective) * 100 : 0;
                        sessionFillEl.style.width = Math.min(dailyPercent,100) + '%';
                        sessionTextEl.textContent = `€${todayEarned.toFixed(2)} / €${dailyObjective} (${Math.round(dailyPercent)}%)`;
                    }
                }catch(eSess){ console.warn('Failed updating session progress', eSess); }
            }catch(e){ console.warn(e); }
        })();

        drawRevenueChart(coursesArray, period);
    }, async err => {
        console.error('Stats snapshot error', err);
        try{
            const msg = (err && (err.message || '')).toLowerCase();
            if(msg.includes('requires an index') || msg.includes('index')){
                console.warn('Stats: index error — using fallback GET for recent courses');
                const fallbackSnap = await db.collection('courses').where('chauffeur_id','==',user.uid).limit(500).get();
                let totalEarned = 0; let totalDistance = 0; let totalTime = 0; const coursesArray = [];
                fallbackSnap.forEach(doc => {
                    const c = doc.data();
                    // include only docs in period when possible
                    let include = true;
                    try{
                        if(c.timestamp_depart && c.timestamp_depart.toDate){ include = c.timestamp_depart.toDate() >= startDate; }
                        else if(c.heure_depart_course){ const d = new Date(c.heure_depart_course); if(!isNaN(d.getTime())) include = d >= startDate; }
                    }catch(e){}
                    if(include){ totalEarned += (c.prix||0); totalDistance += (c.distance||0); totalTime += (c.duree||0); coursesArray.push(c); }
                });

                const avgPrice = coursesArray.length ? totalEarned / coursesArray.length : 0;
                const avgDistance = coursesArray.length ? totalDistance / coursesArray.length : 0;
                const perHour = totalTime ? (totalEarned / totalTime) * 60 : 0;
                const perKm = totalDistance ? totalEarned / totalDistance : 0;

                try{ document.getElementById('kpi-earned').textContent = `€${totalEarned.toFixed(2)}`; }catch(e){}
                try{ document.getElementById('kpi-courses').textContent = coursesArray.length; }catch(e){}
                try{ document.getElementById('kpi-courses-avg').textContent = coursesArray.length ? `${avgPrice.toFixed(2)}€/course` : '—'; }catch(e){}
                try{ document.getElementById('kpi-distance').textContent = `${totalDistance.toFixed(1)} km`; }catch(e){}
                try{ document.getElementById('kpi-distance-avg').textContent = `${avgDistance.toFixed(1)} km/course`; }catch(e){}
                const hours = Math.floor(totalTime / 60); const mins = Math.round(totalTime % 60);
                try{ document.getElementById('metadata-time').textContent = `${hours}h ${mins}min`; }catch(e){}
                try{ document.getElementById('metadata-avg-price').textContent = `€${avgPrice.toFixed(2)}`; }catch(e){}
                try{ document.getElementById('metadata-per-hour').textContent = `€${perHour.toFixed(2)}`; }catch(e){}
                try{ document.getElementById('metadata-per-km').textContent = `€${perKm.toFixed(2)}`; }catch(e){}

                // draw chart and progress using the fallback data
                drawRevenueChart(coursesArray, period);
                // update objective/progress using helper
                try{
                    const obj = await getObjectiveForUser(user.uid, period);
                    const objectifForPeriod = obj.objectifForPeriod || 0;
                    const progressPercent = objectifForPeriod ? (totalEarned / objectifForPeriod) * 100 : 0;
                    try{ document.getElementById('progress-bar-fill').style.width = Math.min(progressPercent,100) + '%'; }catch(e){}
                    try{ document.getElementById('progress-earned').textContent = `€${totalEarned.toFixed(2)}`; }catch(e){}
                    try{ document.getElementById('progress-goal').textContent = `€${objectifForPeriod}`; }catch(e){}
                }catch(e){ console.warn('Failed to update progress after stats fallback', e); }
            }
        }catch(fbErr){ console.error('Stats fallback failed', fbErr); }
    });
}

function startPeriodicRefresh(){
    if(periodicRefreshId) return;
    periodicRefreshId = setInterval(() => {
        const user = firebase.auth().currentUser;
        if(!user) return;
        const activeTab = document.querySelector('.tab-btn.active')?.dataset.tab;
        if(activeTab === 'tab-journee'){
            // refresh daily listener by re-calling with same period (safe: ecouterStats detaches previous)
            const period = 'day';
            ecouterStats(user.uid, period);
        } else if(activeTab === 'tab-stats'){
            const period = document.querySelector('.period-btn.active')?.dataset.period || 'day';
            attachStatsListener(period);
        } else if(activeTab === 'tab-courses'){
            const filter = document.getElementById('courses-filter')?.value || 'today';
            attachCoursesListener(filter);
        }
    }, 60*1000);
}

function stopPeriodicRefresh(){
    if(periodicRefreshId){ clearInterval(periodicRefreshId); periodicRefreshId = null; }
}

function drawRevenueChart(courses, period){
    const ctx = document.getElementById('revenue-chart');
    if(!ctx) return;
    const dataByDay = {};
    courses.forEach(course => {
        let date = null;
        if(course.timestamp_depart && course.timestamp_depart.toDate){
            try{ date = course.timestamp_depart.toDate().toISOString().split('T')[0]; }catch(e){}
        }
        if(!date){
            date = (course.heure_depart_course || '').split(' ')[0] || (new Date()).toISOString().split('T')[0];
        }
        if(!dataByDay[date]) dataByDay[date]=0;
        dataByDay[date]+=course.prix;
    });
    const labels = Object.keys(dataByDay).sort();
    const data = labels.map(l => dataByDay[l]);
    if(statsChart) statsChart.destroy();
    statsChart = new Chart(ctx.getContext('2d'), {
        type:'bar', data:{ labels, datasets:[{ label:'Revenus', data, backgroundColor:'rgba(0,168,107,0.7)', borderColor:'#00A86B', borderRadius:6 }] },
        options:{ responsive:true, plugins:{ legend:{ display:false } }, scales:{ y:{ beginAtZero:true, ticks:{ callback: v => '€'+v } } } }
    });
}

// period buttons
document.addEventListener('DOMContentLoaded', () => {
    if(typeof firebase === 'undefined'){
        console.error('Firebase not loaded for stats.js');
        return;
    }
    db = firebase.firestore();
    setupTabs();
    const filter = document.getElementById('courses-filter');
    if(filter) filter.addEventListener('change', () => attachCoursesListener(filter.value));

    document.querySelectorAll('.period-btn').forEach(btn => btn.addEventListener('click', () => {
        document.querySelectorAll('.period-btn').forEach(b=>b.classList.remove('active'));
        btn.classList.add('active');
        attachStatsListener(btn.dataset.period || 'day');
    }));

    // daily/overview period selector in Jour tab
    document.querySelectorAll('.daily-period-btn').forEach(btn => btn.addEventListener('click', () => {
        document.querySelectorAll('.daily-period-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const uid = firebase.auth().currentUser && firebase.auth().currentUser.uid;
        if(uid) ecouterStats(uid, btn.dataset.period || 'day');
    }));

    // React to auth changes and attach/detach listeners
    firebase.auth().onAuthStateChanged(user => {
        if(user){
            console.log('stats: auth user', user.uid);
            // Attach listeners proactively to ensure the UI shows data immediately
            try{ attachCoursesListener(document.getElementById('courses-filter')?.value || 'today'); }catch(e){}
            try{ attachStatsListener(document.querySelector('.period-btn.active')?.dataset.period || 'day'); }catch(e){}
            try{ ecouterStats(user.uid, document.querySelector('.daily-period-btn.active')?.dataset.period || 'day'); }catch(e){}
            // start periodic refresh to keep UI in sync
            startPeriodicRefresh();
        } else {
            detachCoursesListener();
            detachStatsListener();
            detachDailyStats();
            stopPeriodicRefresh();
        }
    });
    // Ensure initial tab logic runs even if auth state was already resolved earlier
    setTimeout(() => {
        const activeBtn = document.querySelector('.tab-btn.active');
        if(activeBtn) activeBtn.click();
        const user = firebase.auth().currentUser;
        if(user){
            // make sure listeners are attached immediately
            const activeTab = document.querySelector('.tab-btn.active')?.dataset.tab;
            if(activeTab === 'tab-courses') attachCoursesListener(document.getElementById('courses-filter')?.value || 'today');
            if(activeTab === 'tab-stats') attachStatsListener(document.querySelector('.period-btn.active')?.dataset.period || 'day');
            if(activeTab === 'tab-journee') ecouterStats(user.uid, document.querySelector('.daily-period-btn.active')?.dataset.period || 'day');
            startPeriodicRefresh();
        }
    }, 50);
});
