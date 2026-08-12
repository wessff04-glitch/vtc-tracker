// Script de backfill pour ajouter timestamp_depart/timestamp_arrivee aux documents courses
// Usage: coller dans console du navigateur (connecté en admin) ou exécuter depuis une page qui charge Firebase config.

(async function(){
    if(typeof firebase === 'undefined') return console.error('Firebase non chargé');
    const db = firebase.firestore();
    const snapshot = await db.collection('courses').get();
    console.log('Courses total:', snapshot.size);
    let updated = 0;
    for(const doc of snapshot.docs){
        const data = doc.data();
        if(data.timestamp_depart) continue; // déjà présent
        let baseDate = null;
        // try to use createTime if available
        if(doc.createTime && typeof doc.createTime.toDate === 'function'){
            baseDate = doc.createTime.toDate();
        } else if(doc.updateTime && typeof doc.updateTime.toDate === 'function'){
            baseDate = doc.updateTime.toDate();
        } else {
            baseDate = new Date();
        }
        // parse heure_depart_course 'HH:MM' or ISO
        let heureStr = data.heure_depart_course;
        let dateDepart = new Date(baseDate);
        if(heureStr && typeof heureStr === 'string'){
            // if ISO
            if(/\d{4}-\d{2}-\d{2}T/.test(heureStr)){
                try{ dateDepart = new Date(heureStr); }catch(e){}
            } else if(/^\d{2}:\d{2}/.test(heureStr)){
                const parts = heureStr.split(':');
                dateDepart.setHours(parseInt(parts[0],10));
                dateDepart.setMinutes(parseInt(parts[1],10));
                dateDepart.setSeconds(0);
                dateDepart.setMilliseconds(0);
            }
        }
        let dateArrivee = null;
        if(data.heure_arrivee_course && typeof data.heure_arrivee_course === 'string'){
            try{ dateArrivee = new Date(data.heure_arrivee_course); }catch(e){ dateArrivee = null; }
            if(!dateArrivee || isNaN(dateArrivee.getTime())){
                const parts = data.heure_arrivee_course.split(':');
                dateArrivee = new Date(dateDepart);
                dateArrivee.setHours(parseInt(parts[0],10));
                dateArrivee.setMinutes(parseInt(parts[1],10));
            }
        }

        const updates = {};
        try{ updates.timestamp_depart = firebase.firestore.Timestamp.fromDate(dateDepart); }catch(e){}
        if(dateArrivee) try{ updates.timestamp_arrivee = firebase.firestore.Timestamp.fromDate(dateArrivee); }catch(e){}

        if(Object.keys(updates).length){
            await doc.ref.update(updates);
            updated++;
            console.log('Updated', doc.id, updates);
        }
    }
    console.log('Backfill finished. Updated:', updated);
})();
