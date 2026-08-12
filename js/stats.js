// js/stats.js
let statsChart = null;
let coursesUnsub = null;
let statsUnsub = null;

function setupTabs(){
    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const tabName = btn.dataset.tab;
            document.querySelectorAll('.tab-content').forEach(tab => tab.classList.add('hidden'));
            const sel = document.getElementById(tabName);
            if(sel) sel.classList.remove('hidden');
            document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            if(tabName === 'tab-stats') loadStatsData('day');
            if(tabName === 'tab-courses') loadCourses(document.getElementById('courses-filter')?.value || 'today');
        });
    });
}

function detachCoursesListener(){
    if(coursesUnsub){ coursesUnsub(); coursesUnsub = null; }
}

function attachCoursesListener(filter = 'today'){
    detachCoursesListener();
    const user = firebase.auth().currentUser;
    if(!user) return;
    let query = db.collection('courses').where('chauffeur_id','==',user.uid).orderBy('heure_depart_course','desc');
    const now = new Date();
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const startOfWeek = new Date(now.getTime() - 7*24*60*60*1000);
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    if(filter === 'today') query = query.where('heure_depart_course','>=', startOfDay.toISOString());
    else if(filter === 'week') query = query.where('heure_depart_course','>=', startOfWeek.toISOString());
    else if(filter === 'month') query = query.where('heure_depart_course','>=', startOfMonth.toISOString());

    coursesUnsub = query.onSnapshot(snapshot => {
        const coursesList = document.getElementById('courses-list');
        if(!coursesList) return;
        coursesList.innerHTML = '';
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
        document.querySelectorAll('.view-route-btn').forEach(b => {
            b.addEventListener('click', (e) => showCourseMap(e.target.dataset.id));
        });
    }, err => console.error('Courses snapshot error', err));
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
    const now = new Date();
    let startDate = new Date();
    if(period === 'day') startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    else if(period === 'week') startDate = new Date(now.getTime() - 7*24*60*60*1000);
    else if(period === 'month') startDate = new Date(now.getFullYear(), now.getMonth(), 1);

    const query = db.collection('courses').where('chauffeur_id','==',user.uid).where('heure_depart_course','>=', startDate.toISOString());
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

        // progress
        (async ()=>{
            try{
                const chauffeurDoc = await db.collection('chauffeurs').doc(user.uid).get();
                const objectif = (chauffeurDoc.exists && chauffeurDoc.data().objectif_journalier) ? chauffeurDoc.data().objectif_journalier : 350;
                const progressPercent = objectif ? (totalEarned / objectif) * 100 : 0;
                document.getElementById('progress-bar-fill').style.width = Math.min(progressPercent,100) + '%';
                document.getElementById('progress-earned').textContent = `€${totalEarned.toFixed(2)}`;
                document.getElementById('progress-goal').textContent = `€${objectif}`;
                document.getElementById('kpi-earned-vs-goal').textContent = `${Math.round(progressPercent)}% objectif`;
            }catch(e){ console.warn(e); }
        })();

        drawRevenueChart(coursesArray, period);
    }, err => console.error('Stats snapshot error', err));
}

function drawRevenueChart(courses, period){
    const ctx = document.getElementById('revenue-chart');
    if(!ctx) return;
    const dataByDay = {};
    courses.forEach(course => {
        const date = (course.heure_depart_course || '').split(' ')[0] || (new Date()).toISOString().split('T')[0];
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
    setupTabs();
    const filter = document.getElementById('courses-filter');
    if(filter) filter.addEventListener('change', () => loadCourses(filter.value));

    document.querySelectorAll('.period-btn').forEach(btn => btn.addEventListener('click', () => {
        document.querySelectorAll('.period-btn').forEach(b=>b.classList.remove('active'));
        btn.classList.add('active');
        loadStatsData(btn.dataset.period || 'day');
    }));

    // load default tab content
    if(document.querySelector('.tab-btn.active')?.dataset.tab === 'tab-stats') loadStatsData('day');
});
