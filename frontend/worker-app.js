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
        document.getElementById('captureFaceBtn')?.addEventListener('click', () => this.confirmFace());
        document.getElementById('cancelFaceBtn')?.addEventListener('click', () => this.closeFaceModal(true));
        await this.loadLocations();
        this.startLocationTracking();
        this.loadTodayAttendance();
        setInterval(() => this.loadTodayAttendance(), 30000);
    }

    async logout() {
        try {
            await fetch(`${this.baseUrl}/auth.php`, {
                method: 'POST',
                headers: this.headers(),
                credentials: 'include',
                body: JSON.stringify({ action: 'logout' })
            });
        } catch (e) {}
        GeoSession.clear();
        window.location.href = 'login.html';
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
        if (this.locationInitTimeout) clearTimeout(this.locationInitTimeout);
        this.locationInitTimeout = setTimeout(() => {
            if (!this.currentLocation) {
                this.updateLocationStatus(false, 'Location not available. Allow location access and ensure GPS is on');
            }
        }, 8000);

        const onOk = (position) => {
            this.currentLocation = {
                latitude: position.coords.latitude,
                longitude: position.coords.longitude
            };
            this.currentAccuracy = position.coords.accuracy || null;
            this.checkGeofence();
            this.updateButtonStates();
            if (this.locationInitTimeout) { clearTimeout(this.locationInitTimeout); this.locationInitTimeout = null; }
        };
        const onErr = (error) => {
            const map = {
                1: 'Location access denied. Please enable location services.',
                2: 'Location information unavailable.',
                3: 'Location request timed out.'
            };
            const message = map[error.code] || 'Unknown location error.';
            this.updateLocationStatus(false, message);
        };
        navigator.geolocation.getCurrentPosition(onOk, onErr, options);
        navigator.geolocation.watchPosition(onOk, onErr, options);
    }

    checkGeofence() {
        if (!this.currentLocation || this.workplaceLocations.length === 0) {
            this.isWithinGeofence = false;
            this.updateLocationStatus(false, 'Waiting for location or no active workplaces');
            return;
        }
        for (const location of this.workplaceLocations) {
            const distance = this.calculateDistance(
                this.currentLocation.latitude,
                this.currentLocation.longitude,
                parseFloat(location.latitude),
                parseFloat(location.longitude)
            );
            const isActiveVal = String(location.is_active).toLowerCase();
            const isActive = isActiveVal === '1' || isActiveVal === 'true' || location.is_active === 1 || location.is_active === true;
            if (!isActive) continue;
            const effectiveRadius = Number(location.radius_meters || 100) + Math.min(Number(this.currentAccuracy || 0), 800);
            if (distance <= effectiveRadius) {
                this.isWithinGeofence = true;
                this.updateLocationStatus(true, `At ${location.name}`, distance);
                return;
            }
        }
        this.isWithinGeofence = false;
        let nearest = { distance: Infinity, location: null };
        this.workplaceLocations.forEach((location) => {
            const distance = this.calculateDistance(
                this.currentLocation.latitude,
                this.currentLocation.longitude,
                parseFloat(location.latitude),
                parseFloat(location.longitude)
            );
            if (distance < nearest.distance) nearest = { location, distance };
        });
        const accTxt = this.currentAccuracy ? ` | accuracy ±${Math.round(this.currentAccuracy)}m` : '';
        const msg = nearest.location
            ? `Outside work area. Nearest: ${nearest.location.name} (${Math.round(nearest.distance)}m away${accTxt})`
            : `Outside work area${accTxt}.`;
        this.updateLocationStatus(false, msg);
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
            distanceElement.textContent = `You are ${Math.round(distance)}m from center${acc}`;
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
                this.loadTodayAttendance();
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
