class WorkerApp {
    constructor() {
        this.baseUrl = GeoSession.apiRoot();
        this.currentLocation = null;
        this.workplaceLocations = [];
        this.isWithinGeofence = false;
        this.currentWorker = GeoSession.getUser() || null;
        this.hasActiveCheckIn = false;
        this.currentAccuracy = null;
        this.locationInitTimeout = null;
        this.watchId = null;
        this.faceStream = null;
        this.pendingAction = null;
        this.init();
    }

    headers(json = true) {
        const h = GeoSession.headers();
        if (json) h['Content-Type'] = 'application/json';
        return h;
    }

    async init() {
        const allowed = await GeoSession.assertWorker();
        if (!allowed) {
            window.location.replace('login.html');
            return;
        }
        this.currentWorker = GeoSession.getUser();
        document.body.classList.add('worker-ok');
        const nameEl = document.getElementById('workerNameLabel');
        if (nameEl && this.currentWorker) nameEl.textContent = this.currentWorker.name || this.currentWorker.email || '';
        document.getElementById('logoutBtn')?.addEventListener('click', () => this.logout());
        document.getElementById('refreshLocationBtn')?.addEventListener('click', () => this.refreshLocation());
        document.getElementById('captureFaceBtn')?.addEventListener('click', () => this.confirmFace());
        document.getElementById('cancelFaceBtn')?.addEventListener('click', () => this.closeFaceModal(true));
        await this.loadLocations();
        this.startLocationTracking();
        this.loadTodayAttendance();
        setInterval(() => this.loadTodayAttendance(), 30000);
    }

    logout() {
        // Clear local state and leave immediately; the server session is revoked in the background.
        const options = {
            method: 'POST',
            headers: this.headers(),
            credentials: 'include',
            keepalive: true,
            body: JSON.stringify({ action: 'logout' })
        };
        try { fetch(`${this.baseUrl}/auth.php`, options).catch(() => {}); } catch (e) {}
        GeoSession.clear();
        window.location.replace('login.html');
    }

    async loadLocations() {
        try {
            const response = await fetch(`${this.baseUrl}/locations.php`, { headers: this.headers(false), credentials: 'include' });
            if (response.status === 401) { GeoSession.clear(); window.location.href = 'login.html'; return; }
            const all = await response.json();
            this.workplaceLocations = (all || []).filter((l) => Number(l.is_active) === 1 || l.is_active === true);
            if (this.workplaceLocations.length === 0) {
                this.updateLocationStatus(false, 'No active work locations configured');
            }
        } catch (error) {
            this.showMessage('Could not load work locations', 'error');
        }
    }

    startLocationTracking() {
        if (!navigator.geolocation) {
            this.showMessage('Geolocation is not supported by your browser', 'error');
            return;
        }
        const options = { enableHighAccuracy: true, timeout: 25000, maximumAge: 0 };
        if (this.watchId !== null) {
            navigator.geolocation.clearWatch(this.watchId);
            this.watchId = null;
        }
        if (this.locationInitTimeout) clearTimeout(this.locationInitTimeout);
        this._recentFixes = [];
        this._locationJitterConfirmed = false;
        this.locationInitTimeout = setTimeout(() => {
            if (!this._locationJitterConfirmed) {
                this.updateLocationStatus(false, 'GPS signal is weak or coarse. Make sure Precise Location is on, or tap Refresh.');
            }
            document.getElementById('refreshLocationBtn')?.classList.remove('spinning');
        }, 10000);

        const onOk = (position) => {
            const accuracy = position.coords.accuracy || null;
            const lat = position.coords.latitude;
            const lng = position.coords.longitude;
            this.currentLocation = { latitude: lat, longitude: lng };
            this.currentAccuracy = accuracy;
            this.lastLocationAt = Date.now();
            this._recentFixes.push({ lat, lng, accuracy });
            if (this._recentFixes.length > 10) this._recentFixes.shift();

            document.getElementById('refreshLocationBtn')?.classList.remove('spinning');
            this.updateLocationMeta();

            // Compute the spread of recent fixes. Real GPS jitters by a few metres even when
            // standing still; a coarse/snapped (network) position stays frozen. Only trust the
            // geofence verdict once we have seen that natural movement.
            let spread = 0;
            const fixes = this._recentFixes;
            if (fixes.length >= 2) {
                for (let i = 0; i < fixes.length; i++) {
                    for (let j = i + 1; j < fixes.length; j++) {
                        const d = this.calculateDistance(fixes[i].lat, fixes[i].lng, fixes[j].lat, fixes[j].lng);
                        if (d > spread) spread = d;
                    }
                }
            }
            if (spread >= 1.5) this._locationJitterConfirmed = true;

            if (accuracy !== null && accuracy > 50) {
                this.isWithinGeofence = false;
                this.updateLocationStatus(false, `Waiting for a better GPS signal… (currently ±${Math.round(accuracy)}m)`);
                this.updateButtonStates();
                return;
            }
            if (!this._locationJitterConfirmed) {
                this.isWithinGeofence = false;
                this.updateLocationStatus(false, `Waiting for a stable GPS fix… (±${accuracy ? Math.round(accuracy) : '?'}m)`);
                this.updateButtonStates();
                return;
            }
            if (this.locationInitTimeout) { clearTimeout(this.locationInitTimeout); this.locationInitTimeout = null; }
            this.checkGeofence();
            this.updateButtonStates();
        };
        const onErr = (error) => {
            const code = error && error.code;
            const ios = /iP(hone|ad|od)/.test(navigator.userAgent)
                || (navigator.platform === 'MacIntel' && (navigator.maxTouchPoints || 0) > 1);
            let message;
            if (!window.isSecureContext) {
                message = 'Location needs an https:// connection. Open the site securely, then allow location.';
            } else if (code === 1) {
                message = ios
                    ? 'Location is blocked for this site. Tap the “aA” button next to the address bar → Website Settings → Location → Allow, then Reload. (Or iPhone Settings → Safari → Location → Ask/Allow.)'
                    : 'Location is blocked for this site. Tap the padlock / tune icon in the address bar → Permissions → Location → Allow, then reload.';
            } else if (code === 2) {
                message = 'Location unavailable. Turn on GPS / Location services and move near a window, then reload.';
            } else if (code === 3) {
                message = 'Location timed out. Move where the GPS signal is clearer and reload.';
            } else {
                message = 'Unknown location error.';
            }
            this.updateLocationStatus(false, message);
            document.getElementById('refreshLocationBtn')?.classList.remove('spinning');
        };
        this.watchId = navigator.geolocation.watchPosition(onOk, onErr, options);
    }

    refreshLocation() {
        const btn = document.getElementById('refreshLocationBtn');
        if (btn) btn.classList.add('spinning');
        this.updateLocationMeta('Refreshing location…');
        this.startLocationTracking();
        setTimeout(() => btn?.classList.remove('spinning'), 6000);
    }

    updateLocationMeta(note) {
        const meta = document.getElementById('locationMeta');
        if (!meta) return;
        if (note) { meta.textContent = note; return; }
        if (!this.currentLocation) { meta.textContent = ''; return; }
        const acc = this.currentAccuracy ? `±${Math.round(this.currentAccuracy)}m` : 'accuracy unknown';
        const when = this.lastLocationAt ? new Date(this.lastLocationAt).toLocaleTimeString() : '';
        meta.textContent = `GPS signal ${acc}${when ? ` · updated ${when}` : ''}`;
    }

    checkGeofence() {
        if (!this.currentLocation || this.workplaceLocations.length === 0) {
            this.isWithinGeofence = false;
            this.updateLocationStatus(false, 'Waiting for location or no active workplaces');
            return;
        }
        // Small grace zone so minor GPS jitter at the boundary does not block a valid punch.
        const grace = Math.min(Number(this.currentAccuracy || 0), 15);
        let nearest = { distance: Infinity, location: null };
        let misconfigured = false;
        for (const location of this.workplaceLocations) {
            const isActiveVal = String(location.is_active).toLowerCase();
            const isActive = isActiveVal === '1' || isActiveVal === 'true' || location.is_active === 1 || location.is_active === true;
            if (!isActive) continue;

            const polygon = this.normalizePolygon(location.polygon);
            if (polygon) {
                // Ignore degenerate polygons (points overlapping / no real area).
                if (this.polygonAreaSquareMeters(polygon) < 1) { misconfigured = true; continue; }
                const inside = this.pointInPolygon(this.currentLocation.latitude, this.currentLocation.longitude, polygon);
                const edge = this.distanceToPolygon(this.currentLocation.latitude, this.currentLocation.longitude, polygon);
                if (edge !== null && edge < nearest.distance) nearest = { distance: edge, location };
                if (inside || (edge !== null && edge <= grace)) {
                    this.isWithinGeofence = true;
                    this.updateLocationStatus(true, `At ${location.name}`, edge ?? 0);
                    return;
                }
                continue;
            }

            const distance = this.calculateDistance(
                this.currentLocation.latitude,
                this.currentLocation.longitude,
                parseFloat(location.latitude),
                parseFloat(location.longitude)
            );
            if (distance < nearest.distance) nearest = { distance, location };
            const effectiveRadius = Number(location.radius_meters || 100) + grace;
            if (distance <= effectiveRadius) {
                this.isWithinGeofence = true;
                this.updateLocationStatus(true, `At ${location.name}`, distance);
                return;
            }
        }
        this.isWithinGeofence = false;
        if (misconfigured && !nearest.location) {
            this.updateLocationStatus(false, 'A work area geofence is not set up correctly. Please contact your admin.');
            return;
        }
        const accTxt = this.currentAccuracy ? ` | accuracy ±${Math.round(this.currentAccuracy)}m` : '';
        const msg = nearest.location
            ? `Outside work area. Nearest: ${nearest.location.name} (${Math.round(nearest.distance)}m away${accTxt})`
            : `Outside work area${accTxt}.`;
        this.updateLocationStatus(false, msg);
    }

    polygonAreaSquareMeters(points) {
        if (!Array.isArray(points) || points.length < 3) return 0;
        const rad = Math.PI / 180;
        const earth = 6371000;
        let latSum = 0;
        points.forEach((p) => { latSum += p.lat; });
        const cos = Math.cos((latSum / points.length) * rad);
        const xy = points.map((p) => ({ x: p.lng * rad * cos * earth, y: p.lat * rad * earth }));
        let area = 0;
        for (let i = 0, j = xy.length - 1; i < xy.length; j = i++) {
            area += (xy[j].x * xy[i].y) - (xy[i].x * xy[j].y);
        }
        return Math.abs(area) / 2;
    }

    normalizePolygon(value) {
        if (!Array.isArray(value)) return null;
        const points = value
            .filter((p) => p && p.lat !== undefined && p.lng !== undefined && !Number.isNaN(Number(p.lat)) && !Number.isNaN(Number(p.lng)))
            .map((p) => ({ lat: Number(p.lat), lng: Number(p.lng) }));
        return points.length >= 3 ? points : null;
    }

    pointInPolygon(lat, lng, polygon) {
        let inside = false;
        for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
            const yi = polygon[i].lat;
            const xi = polygon[i].lng;
            const yj = polygon[j].lat;
            const xj = polygon[j].lng;
            const intersect = ((yi > lat) !== (yj > lat)) &&
                (lng < (xj - xi) * (lat - yi) / ((yj - yi) || 1e-12) + xi);
            if (intersect) inside = !inside;
        }
        return inside;
    }

    distanceToPolygon(lat, lng, polygon) {
        let min = Infinity;
        for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
            const d = this.distanceToSegment(lat, lng, polygon[j].lat, polygon[j].lng, polygon[i].lat, polygon[i].lng);
            if (d < min) min = d;
        }
        return Number.isFinite(min) ? min : null;
    }

    distanceToSegment(plat, plng, alat, alng, blat, blng) {
        const rad = Math.PI / 180;
        const earth = 6371000;
        const cos = Math.cos(plat * rad);
        const px = plng * rad * cos * earth;
        const py = plat * rad * earth;
        const ax = alng * rad * cos * earth;
        const ay = alat * rad * earth;
        const bx = blng * rad * cos * earth;
        const by = blat * rad * earth;
        const dx = bx - ax;
        const dy = by - ay;
        const len2 = dx * dx + dy * dy;
        if (len2 <= 0) return this.calculateDistance(plat, plng, alat, alng);
        let t = ((px - ax) * dx + (py - ay) * dy) / len2;
        t = Math.max(0, Math.min(1, t));
        const cx = ax + t * dx;
        const cy = ay + t * dy;
        return Math.sqrt((px - cx) ** 2 + (py - cy) ** 2);
    }

    calculateDistance(lat1, lon1, lat2, lon2) {
        const R = 6371000;
        const dLat = (lat2 - lat1) * Math.PI / 180;
        const dLon = (lon2 - lon1) * Math.PI / 180;
        const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
            Math.sin(dLon / 2) ** 2;
        return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    }

    updateLocationStatus(isWithin, message, distance = null) {
        const statusElement = document.getElementById('locationStatus');
        const distanceElement = document.getElementById('distanceInfo');
        const statusDot = document.getElementById('statusDot');
        if (statusElement) statusElement.textContent = message;
        if (!statusDot || !distanceElement) return;
        if (isWithin) {
            statusDot.className = 'status-dot status-ok';
            const acc = this.currentAccuracy ? ` (±${Math.round(this.currentAccuracy)}m)` : '';
            distanceElement.textContent = distance !== null && Number.isFinite(distance)
                ? `Inside the work area · ${Math.round(distance)}m to the boundary${acc}`
                : `Inside the work area${acc}`;
            distanceElement.style.color = '#28a745';
        } else {
            statusDot.className = 'status-dot status-error';
            distanceElement.textContent = message;
            distanceElement.style.color = '#dc3545';
        }
    }

    updateButtonStates() {
        const workerVerified = !!this.currentWorker && !!GeoSession.getToken();
        const canCheckIn = workerVerified && this.isWithinGeofence && !this.hasActiveCheckIn;
        const canCheckOut = workerVerified && this.hasActiveCheckIn;
        const checkinBtn = document.getElementById('checkinBtn');
        const checkoutBtn = document.getElementById('checkoutBtn');
        if (checkinBtn) checkinBtn.disabled = !canCheckIn;
        if (checkoutBtn) checkoutBtn.disabled = !canCheckOut;
    }

    async recordAttendance(action) {
        if (!this.currentWorker) {
            this.showMessage('Login required', 'error');
            return;
        }
        if (!this.currentLocation) {
            this.showMessage('Unable to get your location', 'error');
            return;
        }
        if (action === 'checkin' && !this.isWithinGeofence) {
            this.showMessage('You must be within a work area to check in', 'error');
            return;
        }
        if (action === 'checkin' && this.hasActiveCheckIn) {
            this.showMessage('You already have an open check-in. Check out first.', 'error');
            return;
        }
        if (action === 'checkin') {
            this.pendingAction = 'checkin';
            const opened = await this.openFaceModal();
            if (!opened) this.submitPunch('checkin', null);
            return;
        }
        this.submitPunch('checkout', null);
    }

    async openFaceModal() {
        const modal = document.getElementById('faceModal');
        const video = document.getElementById('faceVideo');
        if (!modal || !video || !navigator.mediaDevices?.getUserMedia) return false;
        try {
            this.faceStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' }, audio: false });
            video.srcObject = this.faceStream;
            modal.classList.add('show');
            return true;
        } catch (e) {
            this.showMessage('Camera unavailable. Checking in without a new face capture.', 'error');
            return false;
        }
    }

    closeFaceModal(cancel) {
        const modal = document.getElementById('faceModal');
        const video = document.getElementById('faceVideo');
        modal?.classList.remove('show');
        if (this.faceStream) {
            this.faceStream.getTracks().forEach((t) => t.stop());
            this.faceStream = null;
        }
        if (video) video.srcObject = null;
        if (cancel) this.pendingAction = null;
    }

    confirmFace() {
        const video = document.getElementById('faceVideo');
        const canvas = document.getElementById('faceCanvas');
        if (!video || !canvas) return;
        const srcW = video.videoWidth;
        const srcH = video.videoHeight;
        if (!srcW || !srcH) {
            this.showMessage('Camera is still starting. Wait a moment, then capture again.', 'error');
            return;
        }
        const maxW = 240;
        const scale = Math.min(1, maxW / srcW);
        canvas.width = Math.max(80, Math.round(srcW * scale));
        canvas.height = Math.max(80, Math.round(srcH * scale));
        canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
        const image = canvas.toDataURL('image/jpeg', 0.5);
        const action = this.pendingAction || 'checkin';
        this.closeFaceModal(false);
        this.showMessage('Sending check-in…', 'success');
        this.submitPunch(action, image);
    }

    async submitPunch(action, image) {
        const btn = document.getElementById(action === 'checkout' ? 'checkoutBtn' : 'checkinBtn');
        GeoSession.setButtonLoading(btn, true);
        try {
            const fingerprint = await GeoSession.fingerprint();
            const body = {
                action,
                latitude: this.currentLocation.latitude,
                longitude: this.currentLocation.longitude,
                accuracy: this.currentAccuracy,
                device_fingerprint: fingerprint
            };
            if (image) body.image = image;
            const response = await fetch(`${this.baseUrl}/attendance.php`, {
                method: 'POST',
                headers: this.headers(),
                credentials: 'include',
                body: JSON.stringify(body)
            });
            const raw = await response.text();
            let result = {};
            try { result = raw ? JSON.parse(raw) : {}; } catch (e) {
                this.showMessage('The server could not process the photo. Try again.', 'error');
                if (action === 'checkin') {
                    this.pendingAction = 'checkin';
                    await this.openFaceModal();
                }
                return;
            }
            if (response.status === 401 && !(result.error && /face|photo/i.test(String(result.error)))) {
                GeoSession.clear();
                window.location.href = 'login.html';
                return;
            }
            if (result.success) {
                this.showMessage(result.message, 'success');
                await this.loadTodayAttendance();
            } else {
                const msg = result.error || result.message || 'Request failed';
                this.showMessage(msg, 'error');
                if (action === 'checkin' && /face|photo|camera|light|clear/i.test(msg)) {
                    this.pendingAction = 'checkin';
                    await this.openFaceModal();
                }
            }
        } catch (error) {
            this.showMessage('Check-in did not complete. Stay on this page and try again.', 'error');
        } finally {
            GeoSession.setButtonLoading(btn, false);
            this.updateButtonStates();
        }
    }

    showMessage(message, type) {
        const messageElement = document.getElementById('message');
        if (!messageElement) return;
        messageElement.textContent = message;
        messageElement.className = `message ${type}`;
        messageElement.style.display = 'block';
        setTimeout(() => { messageElement.style.display = 'none'; }, 5000);
    }

    async loadTodayAttendance() {
        try {
            const response = await fetch(`${this.baseUrl}/reports.php?type=daily`, { headers: this.headers(false), credentials: 'include' });
            if (response.status === 401) { GeoSession.clear(); window.location.href = 'login.html'; return; }
            const records = await response.json();
            const list = Array.isArray(records) ? records : [];
            this.hasActiveCheckIn = list.some((r) => !r.check_out);
            this.displayTodayAttendance(list);
            this.updateButtonStates();
        } catch (error) {
            console.error('Error loading attendance:', error);
        }
    }

    displayTodayAttendance(records) {
        const container = document.getElementById('todayRecord');
        if (!container) return;
        if (!records.length) {
            container.innerHTML = '<div class="record-item"><span>No records for today</span></div>';
            return;
        }
        container.innerHTML = records.map((record) => {
            const checkInTime = new Date(record.check_in).toLocaleTimeString();
            const checkOutTime = record.check_out ? new Date(record.check_out).toLocaleTimeString() : 'Not checked out';
            const extra = record.status === 'late' ? ' · Late' : (record.overtime_minutes > 0 ? ` · OT ${record.overtime_minutes}m` : '');
            return `<div class="record-item"><span>In: ${checkInTime}${extra}</span><span>Out: ${checkOutTime}</span></div>`;
        }).join('');
    }
}

const app = new WorkerApp();
function recordAttendance(action) { app.recordAttendance(action); }
