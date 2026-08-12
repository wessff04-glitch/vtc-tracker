document.addEventListener('DOMContentLoaded', () => {
    if (typeof firebase === 'undefined') {
        console.error('Firebase non chargé.');
        return;
    }

    const auth = firebase.auth();
    const db = firebase.firestore();

    const startBtn = document.getElementById('start-course-btn');
    const mapWrapper = document.getElementById('map-wrapper');
    const mapEl = document.getElementById('map');
    const endCourseSection = document.getElementById('endcourse-state');

    let currentUser = null;
    let activeSessionDoc = null;

    let watchId = null;
    let trajet_gps = [];
    let coords_depart = null;
    let coords_arrivee = null;
    let heure_depart_course = null;
    let heure_arrivee_course = null;

    let map = null;
    let marker = null;
    let polyline = null;
    let animating = false;

    // Récupère la session active pour l'utilisateur connecté
    async function getActiveSession(userId){
        try{
            const sessionsRef = db.collection('sessions');
            const q = sessionsRef.where('chauffeur_id','==',userId).where('heure_fin','==',null).limit(1);
            const snap = await q.get();
            if (snap.empty) return null;
            return snap.docs[0];
        } catch(err){
            console.error('Erreur getActiveSession', err);
            return null;
        }
    }

    // Affiche ou masque le bloc de tracking selon session
    function updateVisibility(){
        if(activeSessionDoc){
            showState('session-active-state');
        } else {
            showState('waiting-state');
        }
    }

    function showState(state){
        // states: waiting-state, session-active-state, course-state, endcourse-state
        const states = ['waiting-state','session-active-state','course-state','endcourse-state'];
        states.forEach(s => {
            const el = document.getElementById(s);
            if(!el) return;
            el.style.display = (s === state) ? 'block' : 'none';
        });
    }

    // Initialisation Leaflet
    function initMap(center){
        if(!map){
            map = L.map('map').setView([center.lat, center.lng], 16);

            // CartoDB Voyager tiles (modern, no API key)
            L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', {
                maxZoom: 19,
                attribution: '© OpenStreetMap contributors © CARTO'
            }).addTo(map);

            // create a car divIcon (SVG) so we can rotate the SVG independently
            const carIcon = L.divIcon({
                className: 'car-icon-wrapper',
                html: `<div class="car-icon"><svg class="car-svg" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" fill="${'#ff6b35'}"><path d="M5 11c-.55 0-1 .45-1 1v3c0 .55.45 1 1 1h.5c.28 0 .5.22.5.5V18c0 .55.45 1 1 1h.5c.55 0 1-.45 1-1v-.5h6V18c0 .55.45 1 1 1h.5c.55 0 1-.45 1-1v-.5c0-.28.22-.5.5-.5H20c.55 0 1-.45 1-1v-3c0-.55-.45-1-1-1H5zm0-2h14l-1.5-3h-11L5 9z"/></svg></div>`,
                iconSize: [40,40],
                iconAnchor: [20,20]
            });

            marker = L.marker([center.lat, center.lng], { icon: carIcon, interactive: false }).addTo(map);
            polyline = L.polyline([[center.lat, center.lng]], {color: '#0b6efd'}).addTo(map);
        } else {
            map.setView([center.lat, center.lng], 16);
            marker.setLatLng([center.lat, center.lng]);
            polyline.setLatLngs([[center.lat, center.lng]]);
        }
    }

    // start and end markers for visual anchors
    let startMarker = null;
    let endMarker = null;
    let overlayIntervalId = null;

    // compute bearing between two lat/lng points in degrees
    function bearingBetween(start, end){
        const toRad = d => d * Math.PI / 180;
        const toDeg = r => r * 180 / Math.PI;
        const lat1 = toRad(start.lat);
        const lat2 = toRad(end.lat);
        const dLon = toRad(end.lng - start.lng);
        const y = Math.sin(dLon) * Math.cos(lat2);
        const x = Math.cos(lat1)*Math.sin(lat2) - Math.sin(lat1)*Math.cos(lat2)*Math.cos(dLon);
        const brng = toDeg(Math.atan2(y, x));
        return (brng + 360) % 360; // 0..360
    }

    // animate marker from start to end over duration(ms)
    function animateMarkerTo(startLatLng, endLatLng, duration = 1000){
        if(!marker || !map) return Promise.resolve();
        return new Promise(resolve => {
            const start = { lat: startLatLng.lat, lng: startLatLng.lng };
            const end = { lat: endLatLng.lat, lng: endLatLng.lng };
            const startTime = performance.now();
            animating = true;

            function step(now){
                const t = Math.min(1, (now - startTime) / duration);
                const lat = start.lat + (end.lat - start.lat) * t;
                const lng = start.lng + (end.lng - start.lng) * t;
                marker.setLatLng([lat, lng]);
                if(t < 1){
                    requestAnimationFrame(step);
                } else {
                    animating = false;
                    resolve();
                }
            }
            requestAnimationFrame(step);
        });
    }

    function addPointToTrajectory(lat, lng, timestamp){
        const p = { lat: lat, lng: lng, timestamp: timestamp };
        trajet_gps.push(p);
        if(polyline) polyline.addLatLng([lat, lng]);
        if(map) map.panTo([lat, lng]);

        // animate marker smoothly from previous pos to new one
        if(marker){
            const prev = marker.getLatLng();
            const next = L.latLng(lat, lng);
            // set rotation based on bearing
            try{
                const brng = bearingBetween({lat: prev.lat, lng: prev.lng}, {lat: next.lat, lng: next.lng});
                const el = marker.getElement && marker.getElement();
                if(el){
                    const svg = el.querySelector('.car-svg');
                    if(svg) svg.style.transform = `rotate(${brng}deg)`;
                }
            }catch(e){/* ignore */}

            // if already animating, just set target (queue minimal)
            if(animating){
                // jump to final (avoid long queue)
                marker.setLatLng(next);
            } else {
                animateMarkerTo(prev, next, 1000).catch(()=>{});
            }
        }
    }

    function startWatching(){
        if(!navigator.geolocation){
            alert('Géolocalisation non supportée par ce navigateur.');
            return;
        }

        // Demande la position actuelle d'abord (permission + point de départ)
        startBtn.disabled = true;
        startBtn.textContent = 'Obtention position...';

        navigator.geolocation.getCurrentPosition(position => {
            const { latitude: lat, longitude: lng } = position.coords;
            const ts = position.timestamp || Date.now();
            coords_depart = { lat: lat, lng: lng };
            heure_depart_course = new Date().toISOString();

            trajet_gps = [];
            addPointToTrajectory(lat, lng, ts);

            // Affiche la carte
            mapWrapper.style.display = 'block';
            initMap(coords_depart);

            // add a styled start marker
            if(startMarker){ startMarker.remove(); startMarker = null; }
            startMarker = L.marker([coords_depart.lat, coords_depart.lng], { 
                icon: L.divIcon({ className: 'start-marker', iconSize:[18,18], iconAnchor:[9,9] }),
                interactive: false
            }).addTo(map);

            // show overlay and start updating live stats
            const overlay = document.getElementById('map-overlay');
            if(overlay){ overlay.style.display = 'block'; }
            if(overlayIntervalId) clearInterval(overlayIntervalId);
            overlayIntervalId = setInterval(updateOverlay, 1000);
            // show course UI
            showState('course-state');

            // Lance le watchPosition
            watchId = navigator.geolocation.watchPosition(pos => {
                const { latitude, longitude } = pos.coords;
                const t = pos.timestamp || Date.now();
                addPointToTrajectory(latitude, longitude, t);
            }, err => {
                console.warn('watchPosition error', err);
            }, { enableHighAccuracy: true, maximumAge: 0, timeout: 10000 });

            // Change le bouton pour permettre l'arrêt
            startBtn.disabled = false;
            startBtn.textContent = 'Terminer la course';

            // Remplacer l'écouteur pour l'arrêt
            startBtn.removeEventListener('click', handleStartClick);
            startBtn.addEventListener('click', handleStopClick);

        }, error => {
            console.error('getCurrentPosition error', error);
            startBtn.disabled = false;
            startBtn.textContent = 'Démarrer une course';
            if(error.code === error.PERMISSION_DENIED){
                alert('Permission de géolocalisation refusée. Impossible de démarrer la course.');
            } else {
                alert('Impossible d’obtenir la position. Réessayez.');
            }
        }, { enableHighAccuracy: true, timeout: 10000 });
    }

    function stopWatchingAndPrompt(){
        if(watchId !== null){
            navigator.geolocation.clearWatch(watchId);
            watchId = null;
        }

        // Position d'arrivée = dernier point du trajet si présent
        if(trajet_gps.length > 0){
            const last = trajet_gps[trajet_gps.length - 1];
            coords_arrivee = { lat: last.lat, lng: last.lng };
        } else {
            coords_arrivee = coords_depart;
        }

        heure_arrivee_course = new Date().toISOString();

        // rotate marker to final bearing if possible
        try{
            if(trajet_gps.length >= 2 && marker){
                const a = trajet_gps[trajet_gps.length - 2];
                const b = trajet_gps[trajet_gps.length - 1];
                const brng = bearingBetween({lat:a.lat, lng:a.lng}, {lat:b.lat, lng:b.lng});
                const el = marker.getElement && marker.getElement();
                if(el){
                    const svg = el.querySelector('.car-svg');
                    if(svg) svg.style.transform = `rotate(${brng}deg)`;
                }
            }
        }catch(e){/* ignore */}

        // Calcul distance en km
        let distance = 0;
        for(let i=1;i<trajet_gps.length;i++){
            const a = { lat: trajet_gps[i-1].lat, lng: trajet_gps[i-1].lng };
            const b = { lat: trajet_gps[i].lat, lng: trajet_gps[i].lng };
            distance += (typeof haversineKm === 'function') ? haversineKm(a,b) : 0;
        }
        distance = Math.round(distance * 1000) / 1000; // 3 décimales

        // Calcul durée en minutes
        let duree = 0;
        try{
            const depart = new Date(heure_depart_course);
            const arrivee = new Date(heure_arrivee_course);
            duree = Math.round(((arrivee - depart) / 60000) * 10) / 10; // 1 décimale
        }catch(e){ duree = 0; }

        // Afficher l'écran de fin de course (résumé + saisie prix)
        // add end marker
        if(endMarker){ endMarker.remove(); endMarker = null; }
        endMarker = L.marker([coords_arrivee.lat, coords_arrivee.lng], {
            icon: L.divIcon({ className: 'end-marker', iconSize:[36,36], iconAnchor:[18,18]}),
            interactive: false
        }).addTo(map);

        // stop overlay updates
        if(overlayIntervalId){ clearInterval(overlayIntervalId); overlayIntervalId = null; }
        const overlay = document.getElementById('map-overlay');
        if(overlay){ overlay.style.display = 'block'; updateOverlay(); }

        // populate endcourse-state summary
        const sd = document.getElementById('summary-distance');
        const sdur = document.getElementById('summary-duration');
        const sdep = document.getElementById('summary-depart');
        const sarr = document.getElementById('summary-arrivee');
        if(sd) sd.textContent = `${distance} km`;
        if(sdur) sdur.textContent = `${duree} min`;
        if(sdep) sdep.textContent = heure_depart_course || '--:--';
        if(sarr) sarr.textContent = heure_arrivee_course || '--:--';

        // show the endcourse-state
        showState('endcourse-state');

        // wire buttons
        const priceInput = document.getElementById('price-input');
        const saveBtn = document.getElementById('save-course-btn');
        const cancelBtn = document.getElementById('cancel-course-btn');

        function cleanupEndListeners(){
            if(saveBtn) saveBtn.removeEventListener('click', onSave);
            if(cancelBtn) cancelBtn.removeEventListener('click', onCancel);
        }

        const onSave = async () => {
            const prix = parseFloat(priceInput && priceInput.value);
            if(isNaN(prix) || prix < 0){ alert('Veuillez saisir un prix valide.'); return; }

            const courseDoc = {
                chauffeur_id: currentUser.uid,
                session_id: activeSessionDoc ? activeSessionDoc.id : null,
                heure_depart_course: heure_depart_course,
                heure_arrivee_course: heure_arrivee_course,
                coords_depart: coords_depart,
                coords_arrivee: coords_arrivee,
                distance: distance,
                duree: duree,
                prix: prix,
                trajet_gps: trajet_gps
            };

            try{
                await db.collection('courses').add(courseDoc);
                alert('Course enregistrée.');
                cleanupEndListeners();
                resetUIAfterCourse();
            }catch(err){
                console.error('Erreur enregistrement course', err);
                alert('Erreur lors de l’enregistrement. Réessayez.');
            }
        };

        const onCancel = () => { cleanupEndListeners(); resetUIAfterCourse(); };

        if(saveBtn) saveBtn.addEventListener('click', onSave);
        if(cancelBtn) cancelBtn.addEventListener('click', onCancel);
    }

    function updateOverlay(){
        // updates #overlay-time and #overlay-distance
        try{
            const timeEl = document.getElementById('overlay-time');
            const distEl = document.getElementById('overlay-distance');
            if(!timeEl || !distEl || !heure_depart_course) return;

            const depart = new Date(heure_depart_course);
            const now = new Date();
            const diff = Math.max(0, now - depart);
            const hh = String(Math.floor(diff/3600000)).padStart(2,'0');
            const mm = String(Math.floor((diff%3600000)/60000)).padStart(2,'0');
            const ss = String(Math.floor((diff%60000)/1000)).padStart(2,'0');
            timeEl.textContent = `${hh}:${mm}:${ss}`;

            // compute distance live
            let liveDist = 0;
            for(let i=1;i<trajet_gps.length;i++){
                const a = { lat: trajet_gps[i-1].lat, lng: trajet_gps[i-1].lng };
                const b = { lat: trajet_gps[i].lat, lng: trajet_gps[i].lng };
                liveDist += (typeof haversineKm === 'function') ? haversineKm(a,b) : 0;
            }
            distEl.textContent = `${(Math.round(liveDist*100)/100).toFixed(2)} km`;
        }catch(e){/* ignore */}
    }

    // deprecated: dynamic form replaced by endcourse-state markup

    function resetUIAfterCourse(){
        // Réinitialise l'interface pour nouvelle course
        // hide map and end states
        const priceInput = document.getElementById('price-input');
        if(priceInput) priceInput.value = '';
        const endSection = document.getElementById('endcourse-state');
        if(endSection) endSection.style.display = 'none';
        if(mapWrapper) mapWrapper.style.display = 'none';

        if(map){
            map.remove();
            map = null;
            marker = null;
            polyline = null;
        }

        if(startMarker){ startMarker.remove(); startMarker = null; }
        if(endMarker){ endMarker.remove(); endMarker = null; }
        if(overlayIntervalId){ clearInterval(overlayIntervalId); overlayIntervalId = null; }
        const overlay = document.getElementById('map-overlay');
        if(overlay){ overlay.style.display = 'none'; document.getElementById('overlay-time').textContent='00:00:00'; document.getElementById('overlay-distance').textContent='0.0 km'; }

        trajet_gps = [];
        coords_depart = null;
        coords_arrivee = null;
        heure_depart_course = null;
        heure_arrivee_course = null;

        startBtn.textContent = 'Démarrer une course';
        startBtn.removeEventListener('click', handleStopClick);
        startBtn.addEventListener('click', handleStartClick);
        // show appropriate state after reset
        if(activeSessionDoc) showState('session-active-state'); else showState('waiting-state');
    }

    // Handlers
    function handleStartClick(e){
        startWatching();
    }
    function handleStopClick(e){
        // Remet le bouton en disabled pendant traitement
        startBtn.disabled = true;
        startBtn.textContent = 'Arrêt en cours...';
        stopWatchingAndPrompt();
        startBtn.disabled = false;
    }

    // Initial setup
    startBtn.addEventListener('click', handleStartClick);

    auth.onAuthStateChanged(async user => {
        if(!user) return;
        currentUser = user;
        activeSessionDoc = await getActiveSession(user.uid);
        updateVisibility();
    });

    // Ré-écouter les changements sur les sessions pour mettre à jour la visibilité
    // (simple polling every 30s pour rester léger)
    setInterval(async () => {
        if(!currentUser) return;
        const newSession = await getActiveSession(currentUser.uid);
        const changed = (!!newSession) !== (!!activeSessionDoc);
        if(changed){
            activeSessionDoc = newSession;
            updateVisibility();
        }
    }, 30000);

});
