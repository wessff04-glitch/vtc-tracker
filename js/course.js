document.addEventListener('DOMContentLoaded', () => {
    if (typeof firebase === 'undefined') {
        console.error('Firebase non chargé.');
        return;
    }

    const auth = firebase.auth();
    const db = firebase.firestore();

    const trackingContainer = document.getElementById('course-tracking-container');
    const startBtn = document.getElementById('start-course-btn');
    const mapWrapper = document.getElementById('map-wrapper');
    const mapEl = document.getElementById('map');
    const formWrapper = document.getElementById('course-form-wrapper');

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
            trackingContainer.style.display = 'block';
        } else {
            trackingContainer.style.display = 'none';
        }
    }

    // Initialisation Leaflet
    function initMap(center){
        if(!map){
            map = L.map('map').setView([center.lat, center.lng], 16);

            L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
                maxZoom: 19,
                attribution: '© OpenStreetMap'
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

        // Afficher formulaire prix
        renderPriceForm({ distance, duree });
    }

    function renderPriceForm({ distance, duree }){
        formWrapper.innerHTML = '';
        formWrapper.style.display = 'block';

        const info = document.createElement('div');
        info.style.marginBottom = '0.5rem';
        info.textContent = `Distance: ${distance} km — Durée: ${duree} min`;

        const input = document.createElement('input');
        input.type = 'number';
        input.min = '0';
        input.step = '0.1';
        input.placeholder = 'Prix (€)';
        input.style.padding = '0.5rem';
        input.style.width = '70%';

        const validateBtn = document.createElement('button');
        validateBtn.textContent = 'Valider';
        validateBtn.style.marginLeft = '0.5rem';

        const cancelBtn = document.createElement('button');
        cancelBtn.textContent = 'Annuler';
        cancelBtn.style.marginLeft = '0.5rem';

        formWrapper.appendChild(info);
        formWrapper.appendChild(input);
        formWrapper.appendChild(validateBtn);
        formWrapper.appendChild(cancelBtn);

        validateBtn.addEventListener('click', async () => {
            const prix = parseFloat(input.value);
            if(isNaN(prix) || prix < 0){
                alert('Veuillez saisir un prix valide.');
                return;
            }

            // Préparer document
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
                resetUIAfterCourse();
            }catch(err){
                console.error('Erreur enregistrement course', err);
                alert('Erreur lors de l’enregistrement. Réessayez.');
            }
        });

        cancelBtn.addEventListener('click', () => {
            resetUIAfterCourse();
        });
    }

    function resetUIAfterCourse(){
        // Réinitialise l'interface pour nouvelle course
        formWrapper.innerHTML = '';
        formWrapper.style.display = 'none';
        mapWrapper.style.display = 'none';

        if(map){
            map.remove();
            map = null;
            marker = null;
            polyline = null;
        }

        trajet_gps = [];
        coords_depart = null;
        coords_arrivee = null;
        heure_depart_course = null;
        heure_arrivee_course = null;

        startBtn.textContent = 'Démarrer une course';
        startBtn.removeEventListener('click', handleStopClick);
        startBtn.addEventListener('click', handleStartClick);
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
