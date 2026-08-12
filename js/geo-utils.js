// Fonctions géographiques utilitaires
// Fournit la fonction `haversineKm(pointA, pointB)` où point = { lat, lng }
(function(global){
    function toRad(deg){ return deg * Math.PI / 180; }

    function haversineKm(a, b){
        if(!a || !b) return 0;
        var R = 6371; // km
        var dLat = toRad(b.lat - a.lat);
        var dLon = toRad(b.lng - a.lng);
        var lat1 = toRad(a.lat);
        var lat2 = toRad(b.lat);

        var sinDLat = Math.sin(dLat/2);
        var sinDLon = Math.sin(dLon/2);
        var aa = sinDLat*sinDLat + sinDLon*sinDLon * Math.cos(lat1) * Math.cos(lat2);
        var c = 2 * Math.atan2(Math.sqrt(aa), Math.sqrt(1-aa));
        return R * c;
    }

    global.haversineKm = haversineKm;
})(window);
