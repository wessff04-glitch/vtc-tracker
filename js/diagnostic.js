document.addEventListener('DOMContentLoaded', () => {
    function makePanel(){
        let panel = document.getElementById('diag-panel');
        if(panel) return panel;
        panel = document.createElement('div');
        panel.id = 'diag-panel';
        panel.style.position = 'fixed';
        panel.style.right = '12px';
        panel.style.bottom = '12px';
        panel.style.zIndex = 9999;
        panel.style.background = 'white';
        panel.style.border = '1px solid rgba(0,0,0,0.08)';
        panel.style.boxShadow = '0 6px 18px rgba(0,0,0,0.06)';
        panel.style.padding = '10px';
        panel.style.borderRadius = '8px';
        panel.style.fontSize = '13px';
        panel.style.maxWidth = '320px';
        panel.style.fontFamily = 'sans-serif';
        panel.innerHTML = '<strong>Diagnostic Firestore</strong><div id="diag-body" style="margin-top:6px"></div>';
        document.body.appendChild(panel);
        return panel;
    }

    const panel = makePanel();
    const body = document.getElementById('diag-body');

    function write(msg){
        const el = document.createElement('div');
        el.textContent = msg;
        body.appendChild(el);
    }

    write('Initialisation...');

    if(typeof firebase === 'undefined'){
        write('Firebase non chargé');
        return;
    }

    try{
        const auth = firebase.auth();
        const db = firebase.firestore();

        auth.onAuthStateChanged(async user => {
            body.innerHTML = '';
            if(!user){
                write('Utilisateur non connecté');
                return;
            }
            write('Utilisateur connecté: ' + user.uid);

            // test 1: lire les courses pour uid
            try{
                const q = db.collection('courses').where('chauffeur_id','==', user.uid).limit(50);
                const snap = await q.get();
                write('Courses pour vous: ' + snap.size);
                snap.forEach(d => write(' • ' + d.id + ' — ' + (d.data().heure_depart_course || 'no-time')));
            }catch(e){
                write('Erreur lecture courses pour uid: ' + (e.message || e));
            }

            // test 2: échantillon global pour inspecter chauffeur_id
            try{
                const sample = await db.collection('courses').limit(10).get();
                write('Exemple chauffeur_id (10 premiers docs):');
                sample.forEach(d => write(' • ' + d.id + ' → ' + JSON.stringify(d.data().chauffeur_id)));
            }catch(e){
                write('Erreur lecture échantillon: ' + (e.message || e));
            }

            // test 3: essayer une lecture sans filtre pour détecter permission error
            try{
                await db.collection('courses').get();
                write('Lecture complète de courses autorisée.');
            }catch(e){
                if(e && e.code === 'permission-denied') write('Permission denied (règles Firestore).');
                else write('Lecture complète erreur: ' + (e.message || e));
            }
        });
    }catch(err){
        write('Erreur diagnostic: ' + (err.message || err));
    }
});
